mod agent;
mod rpc_frame;
mod sessions;

use agent::{AgentState, StartOptions};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
async fn start_agent(
    app: AppHandle,
    state: State<'_, AgentState>,
    options: StartOptions,
) -> Result<agent::StartInfo, String> {
    agent::start(app, &state, options).await
}

#[tauri::command]
async fn stop_agent(app: AppHandle, state: State<'_, AgentState>) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    agent::stop(&state).await?;
    let _ = app.emit("omp://process", serde_json::json!({ "kind": "stopped" }));
    Ok(())
}

#[tauri::command]
async fn rpc_send(state: State<'_, AgentState>, command: serde_json::Value) -> Result<(), String> {
    agent::send(&state, command).await
}

#[tauri::command]
fn list_sessions(
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<sessions::SessionSummary>, String> {
    sessions::list_sessions(&cwd, limit.unwrap_or(40))
}

#[tauri::command]
fn sessions_root() -> String {
    sessions::sessions_root().to_string_lossy().to_string()
}

/// Optional folder to open when no previous workspace is stored.
#[tauri::command]
fn initial_folder() -> Option<String> {
    std::env::var("OMPD_CWD")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            start_agent,
            stop_agent,
            rpc_send,
            list_sessions,
            sessions_root,
            initial_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AgentState>();
            tauri::async_runtime::block_on(async {
                let _ = agent::stop(state.inner()).await;
            });
        }
    });
}
