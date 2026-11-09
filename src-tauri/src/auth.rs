//! Dedicated, attempt-scoped login worker; never shares the coding-agent session.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::agent::StartOptions;

const PREFIX: &str = "OMP_D_AUTH:";

struct Extension(std::path::PathBuf);
impl Extension {
    fn create() -> Result<Self, String> {
        use std::io::Write;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Cannot create login extension")?.as_nanos();
        let path = std::env::temp_dir().join(format!("omp-d-auth-{}-{nonce}.mjs", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|_| "Cannot create login extension")?;
        let extension = Self(path);
        file.write_all(include_bytes!("auth-extension.mjs")).map_err(|_| "Cannot write login extension")?;
        Ok(extension)
    }
}
impl Drop for Extension {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum AuthCommand {
    Login { method: String },
    Answer { id: String, value: String },
}
impl AuthCommand {
    fn into_value(self) -> Result<Value, String> {
        match self {
            Self::Login { method } if !method.is_empty() && method.len() <= 256 => Ok(json!({"type":"login", "method":method})),
            Self::Answer { id, value } if !id.is_empty() && id.len() <= 128 && value.len() <= 64 * 1024 => Ok(json!({"type":"answer", "id":id, "value":value})),
            _ => Err("Invalid authentication command".into()),
        }
    }
}

enum Control { Send(Value), Stop }
struct Worker {
    attempt: String,
    sender: mpsc::Sender<Control>,
    done: oneshot::Receiver<()>,
}
#[derive(Default)]
pub struct AuthState {
    lifecycle: Mutex<()>,
    worker: Mutex<Option<Worker>>,
    generation: Arc<AtomicU64>,
}

// Match the catalog's context allowlist; never inherit prompts/model arguments.
fn context_args(options: &StartOptions) -> (Vec<String>, Option<String>) {
    let mut args = Vec::new();
    let mut profile = None;
    let extra = options.extra_args.as_deref().unwrap_or_default();
    let mut index = 0;
    while index < extra.len() {
        let arg = &extra[index];
        let (flag, inline) = arg.split_once('=').map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        if matches!(flag, "--profile" | "--config" | "--extension" | "-e" | "--hook") {
            let value = inline.map(str::to_owned).or_else(|| { index += 1; extra.get(index).cloned() });
            if let Some(value) = value {
                if flag == "--profile" { profile = Some(value); }
                else { args.push(if flag == "--hook" { "--extension" } else { flag }.to_owned()); args.push(value); }
            }
        } else if flag == "--no-extensions" { args.push(arg.clone()); }
        index += 1;
    }
    (args, profile)
}

async fn stop_locked(state: &AuthState, attempt: Option<&str>) {
    let mut slot = state.worker.lock().await;
    if attempt.is_some_and(|attempt| slot.as_ref().is_none_or(|worker| worker.attempt != attempt)) { return; }
    if let Some(worker) = slot.take() {
        state.generation.fetch_add(1, Ordering::SeqCst);
        drop(slot);
        let _ = worker.sender.send(Control::Stop).await;
        let _ = worker.done.await;
    }
}

pub async fn stop(state: &AuthState, attempt: Option<&str>) -> Result<(), String> {
    let _guard = state.lifecycle.lock().await;
    stop_locked(state, attempt).await;
    Ok(())
}

pub async fn send(state: &AuthState, attempt: &str, command: AuthCommand) -> Result<(), String> {
    let command = command.into_value()?;
    let slot = state.worker.lock().await;
    let worker = slot.as_ref().filter(|worker| worker.attempt == attempt).ok_or("Authentication attempt is no longer active")?;
    worker.sender.try_send(Control::Send(command)).map_err(|_| "Authentication worker is not accepting input".into())
}

pub async fn start(app: AppHandle, state: &AuthState, options: StartOptions, attempt: String, provider: String) -> Result<(), String> {
    let _guard = state.lifecycle.lock().await;
    if attempt.is_empty() || attempt.len() > 256 || provider.is_empty() || provider.len() > 256 {
        return Err("Invalid authentication attempt".into());
    }
    let cwd = std::fs::canonicalize(&options.cwd).map_err(|_| "Cannot open login project directory")?;
    if !cwd.is_dir() { return Err("Login project path is not a directory".into()); }
    let extension = Extension::create()?;
    let program = options.binary.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("omp");
    let (args, profile) = context_args(&options);
    stop_locked(state, None).await;
    let mut command = Command::new(program);
    command.args(["--mode", "rpc", "--no-session"]).args(args)
        .arg("--extension").arg(&extension.0).current_dir(cwd)
        .env("OMP_D_AUTH_PROVIDER", &provider).env("OMP_D_AUTH_ATTEMPT", &attempt)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(profile) = profile { command.env("OMP_PROFILE", profile); }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "Cannot execute configured omp binary for login")?;
    let pid = child.id().ok_or("Login worker has no process id")?;
    #[cfg(windows)]
    let job = match process_job::Job::attach(pid) {
        Ok(job) => job,
        Err(error) => { let _ = child.kill().await; return Err(error); }
    };
    let stdin = child.stdin.take().ok_or("Login worker has no input pipe")?;
    let stdout = child.stdout.take().ok_or("Login worker has no output pipe")?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let active = state.generation.clone();
    let (sender, mut receiver) = mpsc::channel(16);
    let (done_sender, done) = oneshot::channel();
    *state.worker.lock().await = Some(Worker { attempt: attempt.clone(), sender, done });
    tauri::async_runtime::spawn(async move {
        let _extension = extension;
        let mut stdin = Some(stdin);
        let mut lines = BufReader::new(stdout).lines();
        let mut inbox_id: Option<String> = None;
        let inbox_title = format!("__omp_d_auth_inbox__:{attempt}");
        let mut queue = VecDeque::new();
        let startup = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(startup);
        let mut ready = false;
        let mut terminal = false;
        let emit = |event: Value| {
            if active.load(Ordering::SeqCst) == generation {
                let _ = app.emit("omp://auth", json!({"attempt":attempt, "event":event}));
            }
        };
        loop {
            tokio::select! {
                control = receiver.recv() => match control {
                    Some(Control::Send(value)) => {
                        if queue.len() >= 16 { break; }
                        queue.push_back(value);
                    }
                    Some(Control::Stop) | None => { terminal = true; break; }
                },
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(frame) = line.strip_prefix(PREFIX) {
                            let Ok(event) = serde_json::from_str::<Value>(frame) else { break; };
                            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
                            if matches!(kind, "methods" | "prompt" | "url" | "progress" | "success" | "error") {
                                if kind == "methods" { ready = true; }
                                terminal = matches!(kind, "success" | "error");
                                emit(event);
                                if terminal { break; }
                            }
                        } else if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                            if frame["type"] == "extension_ui_request" && frame["method"] == "input" && frame["title"] == inbox_title {
                                if inbox_id.is_some() { break; }
                                inbox_id = frame["id"].as_str().map(str::to_owned);
                            }
                        }
                    }
                    _ => break,
                },
                _ = child.wait() => break,
                _ = &mut startup, if !ready => break,
            }
            if inbox_id.is_some() && !queue.is_empty() {
                let id = inbox_id.take().expect("inbox exists");
                let value = queue.pop_front().expect("command exists");
                let frame = json!({"type":"extension_ui_response", "id":id, "value":value.to_string()});
                let mut bytes = frame.to_string().into_bytes();
                bytes.push(b'\n');
                let result = if let Some(pipe) = stdin.as_mut() {
                    tokio::time::timeout(Duration::from_secs(5), pipe.write_all(&bytes)).await
                } else { break; };
                if !matches!(result, Ok(Ok(()))) { break; }
            }
        }
        if !terminal { emit(json!({"type":"error", "message":"Authentication worker stopped unexpectedly. Check the configured omp installation and retry."})); }
        // Ask the extension to abort first; kill below bounds cancellation even
        // when a provider ignores AbortSignal or has spawned browser helpers.
        if let (Some(id), Some(pipe)) = (inbox_id.take(), stdin.as_mut()) {
            let frame = json!({"type":"extension_ui_response", "id":id, "value":"{\"type\":\"stop\"}"});
            let _ = tokio::time::timeout(Duration::from_millis(200), pipe.write_all(format!("{frame}\n").as_bytes())).await;
        }
        drop(stdin.take());
        let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
        kill_tree(&mut child, pid).await;
        drop(lines);
        #[cfg(windows)]
        drop(job);
        let _ = done_sender.send(());
    });
    Ok(())
}

async fn kill_tree(child: &mut Child, pid: u32) {
    #[cfg(unix)]
    {
        // Kill the group even if its original leader has already exited.
        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().await;
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

// A Windows job owns the whole worker tree, including helpers whose parent
// exits first. Closing its handle is stronger than taskkill's PID-tree snapshot.
#[cfg(windows)]
mod process_job {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, information: *const c_void, length: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub struct Job(isize);
    impl Job {
        pub fn attach(pid: u32) -> Result<Self, String> {
            // SAFETY: all pointers refer to correctly laid-out Windows ABI
            // structures for the duration of the call; every handle is owned.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() { return Err("Cannot isolate authentication process".into()); }
                let job = Self(handle as isize);
                let mut limits = ExtendedLimits::default();
                limits.basic.flags = 0x0000_2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if SetInformationJobObject(handle, 9, &limits as *const _ as *const c_void, std::mem::size_of::<ExtendedLimits>() as u32) == 0 {
                    return Err("Cannot configure authentication process isolation".into());
                }
                let process = OpenProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE
                if process.is_null() { return Err("Cannot isolate authentication process".into()); }
                let assigned = AssignProcessToJobObject(handle, process);
                CloseHandle(process);
                if assigned == 0 { return Err("Cannot isolate authentication process tree".into()); }
                Ok(job)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: this is the unique owned job handle.
            unsafe { CloseHandle(self.0 as Handle); }
        }
    }
}
