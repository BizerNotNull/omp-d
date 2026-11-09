mod agent;
mod auth;
mod catalog;
mod git_status;
mod rpc_frame;
mod sessions;
mod settings;

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
async fn model_catalog(options: StartOptions) -> Result<serde_json::Value, String> {
    catalog::models(options).await
}

#[tauri::command]
async fn model_roles(options: StartOptions) -> Result<std::collections::BTreeMap<String, String>, String> {
    catalog::roles(options).await
}

#[tauri::command]
async fn native_settings(options: StartOptions) -> Result<settings::Settings, String> {
    settings::native_settings(options).await
}

#[tauri::command]
async fn native_setting_write(
    options: StartOptions,
    key: String,
    value: Option<String>,
    reset: bool,
) -> Result<settings::WriteResult, String> {
    settings::native_setting_write(options, key, value, reset).await
}

#[tauri::command]
async fn auth_start(
    app: AppHandle,
    state: State<'_, auth::AuthState>,
    options: StartOptions,
    attempt: String,
    provider: String,
) -> Result<(), String> {
    auth::start(app, &state, options, attempt, provider).await
}

#[tauri::command]
async fn auth_send(
    state: State<'_, auth::AuthState>,
    attempt: String,
    command: auth::AuthCommand,
) -> Result<(), String> {
    auth::send(&state, &attempt, command).await
}

#[tauri::command]
async fn auth_stop(state: State<'_, auth::AuthState>, attempt: String) -> Result<(), String> {
    auth::stop(&state, Some(&attempt)).await
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

#[tauri::command]
async fn git_status(cwd: String) -> Result<Option<git_status::GitStatus>, String> {
    git_status::status(cwd).await
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
        .manage(auth::AuthState::default())
        .invoke_handler(tauri::generate_handler![
            start_agent,
            stop_agent,
            rpc_send,
            model_catalog,
            model_roles,
            native_settings,
            native_setting_write,
            auth_start,
            auth_send,
            auth_stop,
            list_sessions,
            sessions_root,
            git_status,
            initial_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AgentState>();
            tauri::async_runtime::block_on(async {
                let _ = agent::stop(state.inner()).await;
                let auth_state = app_handle.state::<auth::AuthState>();
                let _ = auth::stop(auth_state.inner(), None).await;
            });
        }
    });
}
