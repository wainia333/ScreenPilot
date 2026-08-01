use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn get_main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn ensure_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = get_main_window(app) {
        return Ok(window);
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .ok_or_else(|| "Main window config not found".to_string())?;

    WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

pub fn ensure_vision_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("vision") {
        let _ = window.set_resizable(false);
        return Ok(window);
    }

    let window =
        WebviewWindowBuilder::new(app, "vision", WebviewUrl::App("index.html#vision".into()))
            .title("Vision")
            .inner_size(600.0, 72.0)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .resizable(false)
            .decorations(false)
            .shadow(false)
            .transparent(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    apply_macos_workspace_behavior(&window);

    Ok(window)
}

#[cfg(target_os = "macos")]
pub fn apply_macos_workspace_behavior(window: &WebviewWindow) {
    let window_for_task = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = window_for_task.set_visible_on_all_workspaces(true);
    });
}

#[allow(dead_code)]
#[cfg(not(target_os = "macos"))]
pub fn apply_macos_workspace_behavior(_window: &WebviewWindow) {}
