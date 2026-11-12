use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalEvent {
    Data { data: Vec<u8> },
    Exit { code: u32 },
    Error { message: String },
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct TerminalState(Arc<Mutex<Registry>>);

struct Session {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    input: Mutex<Option<mpsc::SyncSender<String>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    tree: ProcessTree,
    // Waiting never holds a PTY, writer, child, or registry lock.
    stopped: Mutex<bool>,
    exit: Mutex<Option<Result<u32, String>>>,
    exited: Condvar,
}

impl Session {
    fn terminate(&self) {
        let mut stopped = self.stopped.lock().unwrap();
        if *stopped {
            return;
        }
        *stopped = true;
        self.input.lock().unwrap().take();
        // Kill descendants before the shell, and before closing ConPTY (which
        // may itself wait for output to drain). The reader stays independent.
        self.tree.terminate(&self.master);
        let _ = self.killer.lock().unwrap().kill();
    }

    fn finish(&self, result: Result<u32, String>) {
        *self.exit.lock().unwrap() = Some(result);
        self.exited.notify_all();
    }

    fn wait(&self) -> Result<u32, String> {
        let mut exit = self.exit.lock().unwrap();
        while exit.is_none() {
            exit = self.exited.wait(exit).unwrap();
        }
        exit.as_ref().unwrap().clone()
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    // ConPTY uses signed 16-bit dimensions; bound allocation and screen size
    // equally on all platforms rather than truncating caller values.
    if !(1..=4096).contains(&cols) || !(1..=4096).contains(&rows) {
        return Err("Terminal dimensions must be between 1 and 4096".into());
    }
    Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
}

#[tauri::command]
pub async fn terminal_create(
    state: State<'_, TerminalState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<(), String> {
    let registry = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || create(registry, id, cwd, size(cols, rows)?, on_event))
        .await.map_err(|error| error.to_string())?
}

fn create(
    registry: Arc<Mutex<Registry>>,
    id: String,
    cwd: String,
    size: PtySize,
    channel: Channel<TerminalEvent>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid terminal id".into());
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("Terminal working directory does not exist".into());
    }
    // Serialize creation with close/shutdown so no late spawn can escape them.
    let mut entries = registry.lock().unwrap();
    if entries.shutting_down {
        return Err("Application is shutting down".into());
    }
    if entries.sessions.contains_key(&id) {
        return Err("Terminal id already exists".into());
    }
    let pair = portable_pty::native_pty_system().openpty(size).map_err(|error| error.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    // Allocate all workers before launching a process. If any thread or spawn
    // fails, dropping its startup senders releases the other workers; the output
    // worker drains ConPTY while its owner is dropped, even on partial startup.
    let (output_start, output_ready) = mpsc::channel::<Arc<Session>>();
    let (input_start, input_ready) = mpsc::channel::<Arc<Session>>();
    let (wait_start, wait_ready) = mpsc::channel::<(Arc<Session>, Box<dyn Child + Send + Sync>)>();
    let (input, receiver) = mpsc::sync_channel::<String>(64);
    let output_registry = Arc::downgrade(&registry);
    let output_id = id.clone();
    let output_channel = channel.clone();
    std::thread::Builder::new().name("terminal-output".into()).spawn(move || {
        let Ok(session) = output_ready.recv() else {
            let mut reader = reader;
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
            return;
        };
        read_output(reader, &session, &output_channel);
        match session.wait() {
            Ok(code) => { let _ = output_channel.send(TerminalEvent::Exit { code }); }
            Err(message) => {
                let _ = output_channel.send(TerminalEvent::Error { message });
                let _ = output_channel.send(TerminalEvent::Exit { code: 1 });
            }
        }
        if let Some(registry) = output_registry.upgrade() {
            let mut entries = registry.lock().unwrap();
            if entries.sessions.get(&output_id).is_some_and(|current| Arc::ptr_eq(current, &session)) {
                entries.sessions.remove(&output_id);
            }
        }
    }).map_err(|error| error.to_string())?;
    let input_channel = channel.clone();
    std::thread::Builder::new().name("terminal-input".into()).spawn(move || {
        let Ok(session) = input_ready.recv() else { return; };
        let mut writer = writer;
        while let Ok(data) = receiver.recv() {
            if let Err(error) = writer.write_all(data.as_bytes()).and_then(|_| writer.flush()) {
                if !*session.stopped.lock().unwrap() {
                    let _ = input_channel.send(TerminalEvent::Error { message: error.to_string() });
                }
                session.terminate();
                break;
            }
        }
    }).map_err(|error| error.to_string())?;
    std::thread::Builder::new().name("terminal-wait".into()).spawn(move || {
        let Ok((session, mut child)) = wait_ready.recv() else { return; };
        let status = child.wait().map(|status| status.exit_code()).map_err(|error| error.to_string());
        // Descendants can inherit the slave after the shell exits.
        session.terminate();
        // ClosePseudoConsole may block until the independent reader drains it.
        session.master.lock().unwrap().take();
        session.finish(status);
    }).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let shell = std::env::var_os("COMSPEC").filter(|value| !value.is_empty()).unwrap_or_else(|| "cmd.exe".into());
    #[cfg(not(windows))]
    let shell = std::env::var_os("SHELL").filter(|value| !value.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut command = CommandBuilder::new(shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
    drop(pair.slave);
    let tree = match ProcessTree::new(child.as_ref()) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let session = Arc::new(Session {
        master: Mutex::new(Some(pair.master)),
        input: Mutex::new(Some(input)),
        killer: Mutex::new(child.clone_killer()),
        tree,
        stopped: Mutex::new(false),
        exit: Mutex::new(None),
        exited: Condvar::new(),
    });
    // These receivers cannot exit before receiving their startup value.
    let _ = output_start.send(session.clone());
    let _ = input_start.send(session.clone());
    if let Err(error) = wait_start.send((session.clone(), child)) {
        session.terminate();
        let (_, mut child) = error.0;
        let status = child.wait().map(|status| status.exit_code()).map_err(|error| error.to_string());
        session.master.lock().unwrap().take();
        session.finish(status);
        return Err("Terminal wait worker stopped during startup".into());
    }
    entries.sessions.insert(id, session);
    Ok(())
}

fn read_output(mut reader: Box<dyn Read + Send>, session: &Session, channel: &Channel<TerminalEvent>) {
    let mut bytes = [0; 8192];
    let mut connected = true;
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                if connected && channel.send(TerminalEvent::Data { data: bytes[..count].to_vec() }).is_err() {
                    connected = false;
                    session.terminate();
                    // Keep draining: ConPTY shutdown may need the output pipe.
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // Unix PTYs report EIO instead of EOF after the slave is closed.
            #[cfg(unix)]
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => {
                let _ = channel.send(TerminalEvent::Error { message: error.to_string() });
                break;
            }
        }
    }
    session.terminate();
}

#[tauri::command]
pub async fn terminal_write(state: State<'_, TerminalState>, id: String, data: String) -> Result<(), String> {
    let session = state.inner().0.lock().unwrap().sessions.get(&id).cloned().ok_or("Terminal is not running")?;
    // Never block the runtime or UI behind a shell that isn't reading stdin.
    let input = session.input.lock().unwrap();
    input.as_ref().ok_or("Terminal has exited")?.try_send(data).map_err(|error| match error {
        mpsc::TrySendError::Full(_) => "Terminal input buffer is full".into(),
        mpsc::TrySendError::Disconnected(_) => "Terminal has exited".into(),
    })
}

#[tauri::command]
pub async fn terminal_resize(state: State<'_, TerminalState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let size = size(cols, rows)?;
    let session = state.inner().0.lock().unwrap().sessions.get(&id).cloned().ok_or("Terminal is not running")?;
    tauri::async_runtime::spawn_blocking(move || {
        let master = session.master.lock().unwrap();
        master.as_ref().ok_or("Terminal has exited")?.resize(size).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    let registry = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = registry.lock().unwrap().sessions.remove(&id);
        if let Some(session) = session {
            session.terminate();
            let _ = session.wait();
        }
    }).await.map_err(|error| error.to_string())
}

pub fn shutdown(state: &TerminalState) {
    let sessions = {
        let mut registry = state.0.lock().unwrap();
        registry.shutting_down = true;
        std::mem::take(&mut registry.sessions)
    };
    for session in sessions.values() {
        session.terminate();
    }
    for session in sessions.values() {
        let _ = session.wait();
    }
}

#[cfg(unix)]
struct ProcessTree { pid: libc::pid_t }

#[cfg(unix)]
impl ProcessTree {
    fn new(child: &(dyn Child + Send + Sync)) -> Result<Self, String> {
        Ok(Self { pid: child.process_id().ok_or("Missing terminal process id")? as libc::pid_t })
    }

    fn terminate(&self, master: &Mutex<Option<Box<dyn MasterPty + Send>>>) {
        let foreground = master.lock().unwrap().as_ref().and_then(|pty| pty.process_group_leader());
        // Background jobs can have their own process groups. Snapshot the
        // descendant tree before signalling the shell (and reparenting them).
        // `ps` has these POSIX columns on both Linux and macOS; group signalling
        // remains available if a minimal Unix installation has no ps binary.
        let descendants = std::process::Command::new("ps")
            .args(["-A", "-o", "pid=", "-o", "ppid="])
            .output().ok().filter(|output| output.status.success())
            .map(|output| {
                let processes: Vec<(i32, i32)> = String::from_utf8_lossy(&output.stdout)
                    .lines().filter_map(|line| {
                        let mut fields = line.split_whitespace();
                        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
                    }).collect();
                descendants(self.pid, &processes)
            }).unwrap_or_default();
        for &pid in &descendants {
            unsafe { libc::kill(pid, libc::SIGHUP); }
        }
        // portable-pty creates a new session. Signal both its shell group and
        // the foreground job's group, which interactive shells keep separate.
        for group in [Some(self.pid), foreground].into_iter().flatten() {
            if group > 0 {
                unsafe { libc::kill(-group, libc::SIGHUP); }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        for &pid in &descendants {
            unsafe { libc::kill(pid, libc::SIGKILL); }
        }
        for group in [Some(self.pid), foreground].into_iter().flatten() {
            if group > 0 {
                unsafe { libc::kill(-group, libc::SIGKILL); }
            }
        }
    }
}

#[cfg(unix)]
fn descendants(root: i32, processes: &[(i32, i32)]) -> Vec<i32> {
    let mut found = vec![root];
    let mut index = 0;
    while index < found.len() {
        let parent = found[index];
        for &(pid, ppid) in processes {
            if pid > 0 && ppid == parent && !found.contains(&pid) {
                found.push(pid);
            }
        }
        index += 1;
    }
    found.remove(0);
    found.reverse();
    found
}

#[cfg(windows)]
struct ProcessTree { job: usize }

#[cfg(windows)]
impl ProcessTree {
    fn new(child: &(dyn Child + Send + Sync)) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let handle = child.as_raw_handle().ok_or_else(|| "Missing terminal process handle".to_string());
            let result = handle.and_then(|handle| {
                if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0
                    || AssignProcessToJobObject(job, handle as _) == 0 {
                    Err(std::io::Error::last_os_error().to_string())
                } else { Ok(Self { job: job as usize }) }
            });
            if result.is_err() { CloseHandle(job); }
            result
        }
    }

    fn terminate(&self, _master: &Mutex<Option<Box<dyn MasterPty + Send>>>) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1); }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job as _); }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn cleanup_finds_background_descendants_in_unordered_snapshot() {
        // Visit children before their ancestors, regardless of ps output order.
        let processes = [(30, 20), (99, 1), (20, 10), (40, 10), (10, 1)];
        let result = descendants(10, &processes);
        assert_eq!(result.len(), 3);
        assert!(result.iter().position(|pid| *pid == 30).unwrap()
            < result.iter().position(|pid| *pid == 20).unwrap());
        assert!(!result.contains(&10));
        assert!(!result.contains(&99));
    }
}
