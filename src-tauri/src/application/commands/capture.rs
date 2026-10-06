use super::super::{capture_runtime as runtime, capture_video};
use tauri::{AppHandle, WebviewWindow};

fn capture_window(window: &WebviewWindow) -> Result<String, String> {
    let label = window.label();
    if label == "capture" || label.starts_with("capture-pin-") || label.starts_with("capture-scan-")
    {
        Ok(label.to_owned())
    } else {
        Err("此窗口无权访问截图会话".into())
    }
}

#[tauri::command]
pub fn capture_snapshot(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<runtime::Snapshot, String> {
    runtime::snapshot(&app, &capture_window(&window)?)
}
#[tauri::command]
pub async fn capture_ready(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    let label = capture_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || runtime::ready(&app, &label, &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn capture_action(
    app: AppHandle,
    window: WebviewWindow,
    request: runtime::Action,
) -> Result<serde_json::Value, String> {
    let label = capture_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || runtime::action(&app, &label, request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn capture_frame(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    index: usize,
    show_cursor: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    let label = capture_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime::frame(&app, &label, &id, index, show_cursor.unwrap_or(true))
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn capture_export(
    app: AppHandle,
    window: WebviewWindow,
    request: capture_video::Export,
) -> Result<serde_json::Value, String> {
    let label = capture_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || capture_video::export(&app, &label, request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn capture_export_cancel(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    runtime::check(&app, &capture_window(&window)?, &id)?;
    use tauri::Manager;
    app.state::<runtime::CaptureManager>()
        .export_cancelled
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}

#[tauri::command]
pub async fn capture_open(
    app: AppHandle,
    window: WebviewWindow,
    mode: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open capture from the main window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        super::super::capture_service::request(&app, &mode)
    })
    .await
    .map_err(|error| error.to_string())?
}
