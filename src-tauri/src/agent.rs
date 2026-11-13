//! Supervision of the `omp --mode rpc-ui` child process.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::rpc_frame::FrameDecoder;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub cwd: String,
    pub model: Option<String>,
    pub binary: Option<String>,
    pub extra_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub generation: u64,
    pub pid: u32,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
}

pub struct AgentHandle {
    pub child: Arc<Mutex<Child>>,
    pub stdin: Option<ChildStdin>,
    pub pid: u32,
    _workspace_extension: WorkspaceExtension,
}

#[derive(Default)]
pub struct AgentState {
    pub agents: Mutex<HashMap<u64, Arc<Mutex<AgentHandle>>>>,
    pub generation: AtomicU64,
    shutting_down: AtomicBool,
}

impl AgentState {
    pub fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

struct WorkspaceExtension(std::path::PathBuf);

impl WorkspaceExtension {
    fn create() -> Result<Self, String> {
        use std::io::Write;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?.as_nanos();
        let path = std::env::temp_dir().join(format!("omp-d-workspace-{}-{nonce}.mjs", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
            .open(&path).map_err(|error| error.to_string())?;
        let extension = Self(path);
        file.write_all(include_bytes!("workspace-extension.mjs")).map_err(|error| error.to_string())?;
        Ok(extension)
    }
}

impl Drop for WorkspaceExtension {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Start an independent RPC session without disturbing any existing child.
pub async fn start(
    app: AppHandle,
    state: &AgentState,
    options: StartOptions,
) -> Result<StartInfo, String> {
    let canonical = std::fs::canonicalize(&options.cwd)
        .map_err(|e| format!("Cannot open {}: {e}", options.cwd))?;
    if !canonical.is_dir() {
        return Err(format!("Not a directory: {}", options.cwd));
    }
    let cwd = plain_path(&canonical);

    let program = options
        .binary
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "omp".to_string());

    let mut args: Vec<String> = vec![
        "--mode".into(),
        "rpc-ui".into(),
        "--cwd".into(),
        cwd.clone(),
    ];
    if let Some(model) = options
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        args.push("--model".into());
        args.push(model.to_string());
    }
    for arg in options.extra_args.unwrap_or_default() {
        if !arg.trim().is_empty() {
            args.push(arg);
        }
    }
    let workspace_extension = WorkspaceExtension::create()?;
    args.push("--extension".into());
    args.push(workspace_extension.0.to_string_lossy().into_owned());

    let generation = state.next_generation();
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&canonical)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: the agent owns no console of its own.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start `{program}`: {e}"))?;
    let pid = child.id().ok_or("Spawned agent has no pid")?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("Spawned agent has no stdout")?;
    let stderr = child.stderr.take().ok_or("Spawned agent has no stderr")?;

    let info = StartInfo {
        generation,
        pid,
        program,
        args,
        cwd,
    };
    eprintln!(
        "[omp-d] spawning generation {generation}: {} {}",
        info.program,
        info.args.join(" ")
    );

    let child = Arc::new(Mutex::new(child));
    let handle = Arc::new(Mutex::new(AgentHandle {
        child: child.clone(),
        stdin,
        pid,
        _workspace_extension: workspace_extension,
    }));
    {
        let mut agents = state.agents.lock().await;
        if state.shutting_down.load(Ordering::SeqCst) {
            drop(agents);
            stop_handle(handle).await?;
            return Err("Application is shutting down".into());
        }
        agents.insert(generation, handle);
    }

    let _ = app.emit(
        "omp://process",
        serde_json::json!({ "kind": "started", "generation": generation, "pid": pid, "program": info.program, "args": info.args }),
    );

    spawn_stdout_reader(app.clone(), stdout, generation);
    spawn_stderr_reader(app.clone(), stderr, generation);
    spawn_exit_monitor(app, child, generation);
    Ok(info)
}

/// Remove only the requested child before performing its potentially slow shutdown.
pub async fn stop(state: &AgentState, generation: u64) -> Result<(), String> {
    let handle = state.agents.lock().await.remove(&generation);
    match handle {
        Some(handle) => stop_handle(handle).await,
        None => Ok(()),
    }
}

/// Prevent new registrations and stop every owned child on application exit.
pub async fn stop_all(state: &AgentState) {
    let handles = {
        let mut agents = state.agents.lock().await;
        state.shutting_down.store(true, Ordering::SeqCst);
        agents.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
    };
    let mut stops = tokio::task::JoinSet::new();
    for handle in handles {
        stops.spawn(stop_handle(handle));
    }
    while stops.join_next().await.is_some() {}
}

async fn stop_handle(handle: Arc<Mutex<AgentHandle>>) -> Result<(), String> {
    let mut handle = handle.lock().await;
    // Dropping stdin makes the agent drain accepted commands and exit 0.
    drop(handle.stdin.take());
    let mut child = handle.child.lock().await;
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("Failed waiting for agent exit: {e}")),
        Err(_) => {
            eprintln!("[omp-d] graceful stop timed out for pid {}", handle.pid);
            kill_tree(handle.pid);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.kill()).await;
            let _ = child.wait().await;
        }
    }
    Ok(())
}

/// Write one JSON command to the agent's stdin.
pub async fn send(state: &AgentState, generation: u64, command: Value) -> Result<(), String> {
    if !command.is_object() {
        return Err("RPC command must be a JSON object".into());
    }
    let mut line =
        serde_json::to_string(&command).map_err(|e| format!("Cannot encode RPC command: {e}"))?;
    if line.len() > crate::rpc_frame::MAX_REASSEMBLED_BYTES {
        return Err("RPC command exceeds the transport limit".into());
    }
    line.push('\n');

    let handle = state.agents.lock().await.get(&generation).cloned()
        .ok_or("Agent is not running")?;
    let mut handle = handle.lock().await;
    let stdin = handle.stdin.as_mut().ok_or("Agent stdin is closed")?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Writing to agent failed: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Flushing agent stdin failed: {e}"))
}

fn spawn_stdout_reader(app: AppHandle, stdout: tokio::process::ChildStdout, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut decoder = FrameDecoder::new();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed: Value = match serde_json::from_str(&line) {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = app.emit(
                                "omp://protocol",
                                serde_json::json!({
                                    "kind": "parse_error",
                                    "generation": generation,
                                    "message": error.to_string(),
                                    "line": truncate(&line, 800),
                                }),
                            );
                            continue;
                        }
                    };
                    match decoder.push(parsed) {
                        Ok(Some(frame)) => {
                            let _ = app.emit(
                                "omp://frame",
                                serde_json::json!({ "generation": generation, "frame": frame }),
                            );
                        }
                        Ok(None) => {}
                        Err(message) => {
                            let _ = app.emit(
                                "omp://protocol",
                                serde_json::json!({
                                    "kind": "protocol_error",
                                    "generation": generation,
                                    "message": message,
                                }),
                            );
                        }
                    }
                }
                Ok(None) => {
                    eprintln!("[omp-d] stdout EOF for generation {generation}");
                    let _ = app.emit(
                        "omp://process",
                        serde_json::json!({ "kind": "eof", "generation": generation }),
                    );
                    break;
                }
                Err(error) => {
                    eprintln!("[omp-d] stdout read failed for generation {generation}: {error}");
                    let _ = app.emit(
                        "omp://process",
                        serde_json::json!({
                            "kind": "error",
                            "generation": generation,
                            "message": format!("Reading agent output failed: {error}"),
                        }),
                    );
                    break;
                }
            }
        }
    });
}

/// Poll the direct child's exit status: omp descendants can inherit stdout,
/// so EOF on the pipe is not proof that the agent itself ended.
fn spawn_exit_monitor(app: AppHandle, child: Arc<Mutex<Child>>, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let mut guard = child.lock().await;
            match guard.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    eprintln!("[omp-d] generation {generation} exited with {code:?}");
                    let _ = app.emit(
                        "omp://process",
                        serde_json::json!({ "kind": "exit", "generation": generation, "exitCode": code }),
                    );
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("[omp-d] exit monitor failed for generation {generation}: {error}");
                    return;
                }
            }
        }
    });
}

fn spawn_stderr_reader(app: AppHandle, stderr: tokio::process::ChildStderr, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = truncate(&line, 4000);
            eprintln!("[omp stderr {generation}] {line}");
            let _ = app.emit(
                "omp://stderr",
                serde_json::json!({ "generation": generation, "line": line }),
            );
        }
    });
}

fn plain_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy().to_string();
    value
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(value)
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    async fn echo_agent(state: &AgentState) -> (u64, tokio::process::ChildStdout) {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/D", "/Q", "/C", "findstr ."]);
            command
        };
        #[cfg(not(windows))]
        let mut command = Command::new("cat");
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped())
            .stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let generation = state.next_generation();
        let handle = AgentHandle {
            stdin: child.stdin.take(),
            pid: child.id().unwrap(),
            child: Arc::new(Mutex::new(child)),
            _workspace_extension: WorkspaceExtension::create().unwrap(),
        };
        state.agents.lock().await.insert(generation, Arc::new(Mutex::new(handle)));
        (generation, stdout)
    }

    async fn output(mut stdout: tokio::process::ChildStdout) -> Vec<Value> {
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(5), stdout.read_to_string(&mut text))
            .await.unwrap().unwrap();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn routes_commands_and_stops_only_the_requested_generation() {
        let state = AgentState::default();
        let (first, first_stdout) = echo_agent(&state).await;
        let (second, second_stdout) = echo_agent(&state).await;
        assert_ne!(first, second);
        let first_command = serde_json::json!({ "type": "first" });
        let second_command = serde_json::json!({ "type": "second" });
        let after_stop = serde_json::json!({ "type": "still-running" });
        send(&state, first, first_command.clone()).await.unwrap();
        send(&state, second, second_command.clone()).await.unwrap();
        stop(&state, first).await.unwrap();
        assert_eq!(output(first_stdout).await, vec![first_command]);
        assert!(send(&state, first, serde_json::json!({ "type": "stale" })).await.is_err());
        stop(&state, first).await.unwrap();
        send(&state, second, after_stop.clone()).await.unwrap();
        stop(&state, second).await.unwrap();
        assert_eq!(output(second_stdout).await, vec![second_command, after_stop]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_closes_every_registered_child() {
        let state = AgentState::default();
        let (first, first_stdout) = echo_agent(&state).await;
        let (second, second_stdout) = echo_agent(&state).await;
        stop_all(&state).await;
        assert!(state.agents.lock().await.is_empty());
        assert!(state.shutting_down.load(Ordering::SeqCst));
        assert!(output(first_stdout).await.is_empty());
        assert!(output(second_stdout).await.is_empty());
        assert!(send(&state, first, serde_json::json!({ "type": "stale" })).await.is_err());
        assert!(send(&state, second, serde_json::json!({ "type": "stale" })).await.is_err());
    }
}
