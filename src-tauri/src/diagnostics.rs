//! Process-wide, metadata-only diagnostics. Call shutdown after stopping producers.
use std::{
    collections::VecDeque,
    error::Error,
    fmt,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use serde::Deserialize;
use tracing::{Event, Subscriber};
use tracing_subscriber::{
    EnvFilter,
    fmt::{FmtContext, FormatEvent, FormatFields, format::Writer},
    prelude::*,
    registry::LookupSpan,
};

const PROFILE_FRAMES: usize = 120;
const PROFILE_BYTES: usize = 32 * 1024 * 1024;
const PROFILE_FILE_BYTES: usize = 64 * 1024 * 1024;
const PROFILE_FILES: usize = 8;
const PROFILE_SCOPES: usize = 4096;
const LOG_FILE_BYTES: usize = 8 * 1024 * 1024;
const LOG_FILES: usize = 24;

pub struct Diagnostics {
    // Keeping this lock throughout shutdown makes concurrent callers wait for flushing.
    resources: Mutex<Option<Resources>>,
}
struct Resources {
    profiler: Option<Profiler>,
    writer: tracing_appender::non_blocking::WorkerGuard,
}

impl Diagnostics {
    pub fn shutdown(&self) {
        let mut resources = self.resources.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut owned) = resources.take() {
            if let Some(profiler) = owned.profiler.take() {
                profiler.stop();
            }
            tracing::info!(target: "omp_d::diagnostics", event = "diagnostics_stopped");
            drop(owned.writer);
        }
    }
}
impl Drop for Diagnostics {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn init(home: &Path) -> Result<Diagnostics, Box<dyn Error>> {
    let environment = if cfg!(debug_assertions) { "dev" } else { "release" };
    let root = home.join(".omp").join("ompd").join(environment);
    let logs = root.join("logs");
    fs::create_dir_all(&logs)?;
    let filter = match std::env::var("OMPD_LOG") {
        Ok(value) => EnvFilter::try_new(value)?,
        Err(std::env::VarError::NotPresent) => EnvFilter::try_new("info")?,
        Err(error) => return Err(error.into()),
    };
    let profile = match std::env::var("OMPD_PROFILE") {
        Ok(value) => value == "1",
        Err(std::env::VarError::NotPresent) => false,
        Err(error) => return Err(error.into()),
    };
    let pid = std::process::id();
    let run_id = format!("{}-{pid}", SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos());
    let appender = BoundedLogs::new(&logs, &run_id)?;
    let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(4096)
        .lossy(true)
        .finish(appender);
    let profiler = if profile { Some(Profiler::start(&root.join("profiles"), &run_id)?) } else { None };
    let diagnostics = Diagnostics {
        resources: Mutex::new(Some(Resources { profiler, writer: guard })),
    };
    // Formatter-owned metadata reaches every thread, unlike an entered root span.
    let metadata = format!(
        "{{\"run_id\":\"{run_id}\",\"version\":\"{}\",\"environment\":\"{environment}\",\"pid\":{pid},",
        env!("CARGO_PKG_VERSION"),
    );
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            matches!(metadata.target(), "omp_d" | "omp_d_lib")
                || metadata.target().starts_with("omp_d::") || metadata.target().starts_with("omp_d_lib::")
        }))
        .with(tracing_subscriber::fmt::layer()
            .event_format(ProcessJson { metadata })
            .fmt_fields(tracing_subscriber::fmt::format::JsonFields::new())
            .with_ansi(false)
            .log_internal_errors(false)
            .with_writer(writer))
        .try_init()?;
    // Preserve the original console behavior without persisting payloads or paths.
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!(target: "omp_d::diagnostics", event = "panic", payload_redacted = true);
        original(info);
    }));
    tracing::info!(target: "omp_d::diagnostics", event = "diagnostics_started", profiling = profile);
    Ok(diagnostics)
}

struct ProcessJson { metadata: String }
impl<S, N> FormatEvent<S, N> for ProcessJson
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, ctx: &FmtContext<'_, S, N>, mut writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        writer.write_str(&self.metadata)?;
        let mut envelope = JsonBody { writer, first: true };
        tracing_subscriber::fmt::format().json().with_ansi(false)
            .format_event(ctx, Writer::new(&mut envelope), event)
    }
}
// Stream the standard JSON formatter's body without allocating a second event string.
struct JsonBody<'a> { writer: Writer<'a>, first: bool }
impl fmt::Write for JsonBody<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.first && !value.is_empty() {
            self.first = false;
            self.writer.write_str(value.strip_prefix('{').ok_or(fmt::Error)?)
        } else {
            self.writer.write_str(value)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FrontendReport {
    Ipc {
        command: String,
        #[serde(rename = "durationMs")]
        duration_ms: f64,
        success: bool,
    },
    Error { source: String },
}
impl FrontendReport {
    fn validate(&self) -> Result<(), String> {
        let valid = match self {
            Self::Ipc { command, duration_ms, .. } => {
                !command.is_empty() && command.len() <= 64
                    && command != "report_frontend"
                    && command.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
                    && duration_ms.is_finite() && *duration_ms >= 0.0
            }
            Self::Error { source } => source.len() <= 32 && matches!(source.as_str(),
                "window_error" | "unhandled_rejection" | "react_boundary"),
        };
        if valid { Ok(()) } else { Err("Invalid diagnostic report".into()) }
    }
}

#[tauri::command]
pub fn report_frontend(report: FrontendReport) -> Result<(), String> {
    report.validate()?;
    match report {
        FrontendReport::Ipc { command, duration_ms, success } => {
            tracing::info!(target: "omp_d::frontend", event = "ipc", command, duration_ms, success);
        }
        FrontendReport::Error { source } => {
            tracing::warn!(target: "omp_d::frontend", event = "error", source);
        }
    }
    Ok(())
}

struct Profiler { stop: mpsc::Sender<()>, thread: JoinHandle<()> }
impl Profiler {
    fn start(directory: &Path, run_id: &str) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        retain_captures(directory, PROFILE_FILES - 1)?;
        let final_path = directory.join(format!("{run_id}.puffin"));
        let temporary_path = directory.join(format!("{run_id}.partial"));
        // Fail startup immediately if captures cannot be opened, not at application exit.
        let file = File::create(&temporary_path)?;
        let (stop, receiver) = mpsc::channel();
        let thread = thread::Builder::new().name("ompd-profiler".into()).spawn(move || {
            let capture = Arc::new(Mutex::new(Capture::default()));
            let sink_capture = Arc::clone(&capture);
            let sink = {
                let mut global = puffin::GlobalProfiler::lock();
                global.emit_scope_snapshot();
                global.add_sink(Box::new(move |frame| {
                    sink_capture.lock().unwrap_or_else(|e| e.into_inner()).push(frame);
                }))
            };
            puffin::set_scopes_on(true);
            loop {
                // Static, synchronous scope guarantees a valid idle capture too.
                { puffin::profile_scope!("diagnostics_frame"); }
                puffin::GlobalProfiler::lock().new_frame();
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                    _ => break,
                }
            }
            puffin::set_scopes_on(false);
            {
                let mut global = puffin::GlobalProfiler::lock();
                global.new_frame();
                drop(global.remove_sink(sink));
            }
            let mut output = LimitedWriter { inner: file, remaining: PROFILE_FILE_BYTES };
            let result = capture.lock().unwrap_or_else(|e| e.into_inner()).write(&mut output)
                .and_then(|()| output.inner.sync_all().map_err(Into::into));
            drop(output);
            if result.is_ok() && fs::rename(&temporary_path, &final_path).is_ok() {
                tracing::info!(target: "omp_d::diagnostics", event = "profile_saved");
            } else {
                let _ = fs::remove_file(&temporary_path);
                tracing::error!(target: "omp_d::diagnostics", event = "profile_save_failed");
                eprintln!("omp-d: failed to save profiler capture (details redacted)");
            }
        })?;
        Ok(Self { stop, thread })
    }
    fn stop(self) {
        let _ = self.stop.send(());
        if self.thread.join().is_err() {
            tracing::error!(target: "omp_d::diagnostics", event = "profile_thread_failed");
        }
    }
}

#[derive(Default)]
struct Capture {
    frames: VecDeque<Arc<puffin::FrameData>>,
    scopes: puffin::ScopeCollection,
    bytes: usize,
}
impl Capture {
    fn push(&mut self, frame: Arc<puffin::FrameData>) {
        // Only static scope names/data belong in the profiler; never user text.
        if frame.scope_delta.len().saturating_add(self.scopes.scopes_by_id().len()) > PROFILE_SCOPES {
            return;
        }
        for scope in &frame.scope_delta { self.scopes.insert(scope.clone()); }
        frame.pack();
        let size = frame.bytes_of_ram_used();
        if size > PROFILE_BYTES { return; }
        while self.frames.len() >= PROFILE_FRAMES || self.bytes + size > PROFILE_BYTES {
            if let Some(old) = self.frames.pop_front() { self.bytes -= old.bytes_of_ram_used(); }
        }
        self.bytes += size;
        self.frames.push_back(frame);
    }
    fn write(&self, writer: &mut impl Write) -> Result<(), Box<dyn Error + Send + Sync>> {
        writer.write_all(b"PUF0")?;
        for (index, frame) in self.frames.iter().enumerate() {
            // Old frames can be evicted: export a full scope dictionary on the first one.
            frame.write_into((index == 0).then_some(&self.scopes), writer)?;
        }
        Ok(())
    }
}
struct LimitedWriter<W> { inner: W, remaining: usize }
impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > self.remaining { return Err(io::Error::other("profile capture size limit")); }
        let written = self.inner.write(buffer)?;
        self.remaining -= written;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> { self.inner.flush() }
}

struct BoundedLogs {
    directory: PathBuf,
    run_id: String,
    sequence: u64,
    file: File,
    bytes: usize,
}
impl BoundedLogs {
    fn new(directory: &Path, run_id: &str) -> io::Result<Self> {
        retain_files(directory, LOG_FILES - 1, &["jsonl"])?;
        let file = File::create(directory.join(format!("ompd-{run_id}-{:020}.jsonl", 0)))?;
        Ok(Self { directory: directory.to_owned(), run_id: run_id.into(), sequence: 0, file, bytes: 0 })
    }
}
impl Write for BoundedLogs {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // NonBlocking delivers one formatted event per write; never truncate JSON.
        if bytes.len() > LOG_FILE_BYTES { return Ok(bytes.len()); }
        if self.bytes + bytes.len() > LOG_FILE_BYTES {
            self.file.flush()?;
            self.sequence += 1;
            self.file = File::create(self.directory.join(format!("ompd-{}-{:020}.jsonl", self.run_id, self.sequence)))?;
            self.bytes = 0;
            retain_files(&self.directory, LOG_FILES, &["jsonl"])?;
        }
        self.file.write_all(bytes)?;
        self.bytes += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { self.file.flush() }
}
fn retain_captures(directory: &Path, keep: usize) -> io::Result<()> {
    retain_files(directory, keep, &["puffin", "partial"])
}
fn retain_files(directory: &Path, keep: usize, extensions: &[&str]) -> io::Result<()> {
    let mut captures = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.path().extension().is_some_and(|ext| extensions.iter().any(|expected| ext == *expected))
        {
            captures.push((entry.metadata()?.modified()?, entry.path()));
        }
    }
    captures.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, path) in captures.into_iter().skip(keep) { fs::remove_file(path)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_report_rejects_private_and_invalid_payloads() {
        for input in [
            r#"{"kind":"error","source":"private exception text"}"#,
            r#"{"kind":"error","source":"window_error","message":"secret"}"#,
            r#"{"kind":"ipc","command":"report_frontend","durationMs":1,"success":true}"#,
            r#"{"kind":"ipc","command":"rpc_send","durationMs":-1,"success":true}"#,
            r#"{"kind":"ipc","command":"private text / path","durationMs":1,"success":true}"#,
        ] {
            assert!(serde_json::from_str::<FrontendReport>(input).map(|r| r.validate().is_err()).unwrap_or(true));
        }
        assert!(FrontendReport::Ipc { command: "rpc_complete".into(), duration_ms: f64::NAN, success: true }.validate().is_err());
        assert!(FrontendReport::Ipc { command: "rpc_complete".into(), duration_ms: 12.0, success: true }.validate().is_ok());
        assert!(FrontendReport::Ipc { command: "future_operation".into(), duration_ms: 12.0, success: true }.validate().is_ok());
    }

    #[derive(Clone)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);
    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    #[test]
    fn process_metadata_produces_valid_json_without_global_installation() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let buffer = Buffer(bytes.clone());
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .event_format(ProcessJson { metadata: "{\"run_id\":\"test\",\"version\":\"0\",\"environment\":\"dev\",\"pid\":1,".into() })
                .fmt_fields(tracing_subscriber::fmt::format::JsonFields::new())
                .with_ansi(false).with_writer(move || buffer.clone()),
        );
        tracing::subscriber::with_default(subscriber, || tracing::info!(event = "test", success = true));
        let bytes = bytes.lock().unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["run_id"], "test");
        assert_eq!(json["fields"]["success"], true);
        assert!(!bytes.contains(&0x1b));
    }

    #[test]
    fn limited_writer_does_not_exceed_capture_budget() {
        let mut writer = LimitedWriter { inner: Vec::new(), remaining: 4 };
        writer.write_all(b"PUF0").unwrap();
        assert!(writer.write_all(b"overflow").is_err());
        assert_eq!(writer.inner.len(), 4);
    }

    #[test]
    fn retention_removes_old_captures_and_stale_partial_files_only() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("ompd-retention-{}-{unique}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        for name in ["one.puffin", "two.puffin", "stale.partial", "unrelated.txt"] {
            fs::write(directory.join(name), b"test").unwrap();
        }
        retain_captures(&directory, 1).unwrap();
        let count = fs::read_dir(&directory).unwrap().flatten().filter(|entry| {
            entry.path().extension().is_some_and(|ext| ext == "puffin" || ext == "partial")
        }).count();
        assert_eq!(count, 1);
        assert!(directory.join("unrelated.txt").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
