//! Supervision of the `omp --mode rpc-ui` child process.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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
}

#[derive(Default)]
pub struct AgentState {
    pub agent: Mutex<Option<AgentHandle>>,
    pub generation: AtomicU64,
    /// Serializes start/stop so overlapping host calls cannot stop each other's child.
    pub start_lock: Mutex<()>,
}

impl AgentState {
    pub fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Start a fresh RPC session, replacing any running child.
pub async fn start(
    app: AppHandle,
    state: &AgentState,
    options: StartOptions,
) -> Result<StartInfo, String> {
    let _start_guard = state.start_lock.lock().await;
    let canonical = std::fs::canonicalize(&options.cwd)
        .map_err(|e| format!("Cannot open {}: {e}", options.cwd))?;
    if !canonical.is_dir() {
        return Err(format!("Not a directory: {}", options.cwd));
    }
    let cwd = plain_path(&canonical);
    stop(state).await?;

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
    *state.agent.lock().await = Some(AgentHandle {
        child: child.clone(),
        stdin,
        pid,
    });

    let _ = app.emit(
        "omp://process",
        serde_json::json!({ "kind": "started", "generation": generation, "pid": pid, "program": info.program, "args": info.args }),
    );

    spawn_stdout_reader(app.clone(), stdout, generation);
    spawn_stderr_reader(app.clone(), stderr, generation);
    spawn_exit_monitor(app, child, generation);
    Ok(info)
}

/// Stop the running child, closing stdin first so omp can shut down cleanly.
pub async fn stop(state: &AgentState) -> Result<(), String> {
    let handle = state.agent.lock().await.take();
    let Some(mut handle) = handle else {
        return Ok(());
    };

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
pub async fn send(state: &AgentState, command: Value) -> Result<(), String> {
    if !command.is_object() {
        return Err("RPC command must be a JSON object".into());
    }
    let mut line =
        serde_json::to_string(&command).map_err(|e| format!("Cannot encode RPC command: {e}"))?;
    if line.len() > crate::rpc_frame::MAX_REASSEMBLED_BYTES {
        return Err("RPC command exceeds the transport limit".into());
    }
    line.push('\n');

    let mut guard = state.agent.lock().await;
    let handle = guard.as_mut().ok_or("Agent is not running")?;
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
