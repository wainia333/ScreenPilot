use crate::application::lifecycle::TRANSLATOR_HEIGHT;
use crate::application::state::AppState;
use crate::domain::settings::{AppSettings, ModelSelection, OcrMethod, TranslationMethod};
use crate::infrastructure::ai_http::{
    complete_text, complete_vision, stream_vision, AiMessage, AiRequestPolicy, AiStreamFinish,
    VisionCompletion,
};
use crate::infrastructure::credentials::CredentialVault;
use crate::infrastructure::sse::SseDelta;
use crate::infrastructure::{ocr, translation};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalUnit, Manager, PixelUnit, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowSizeConstraints,
};
use uuid::Uuid;
use xcap::Monitor;

#[derive(Clone, Deserialize)]
pub struct ExplainMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingRect {
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    hit_region: Option<HitRegionRect>,
}

#[derive(Clone, Copy, Deserialize)]
struct FloatingPoint {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingFlyRect {
    from: FloatingPoint,
    to: FloatingPoint,
    width: f64,
    height: f64,
    duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Deserialize)]
pub struct HitRegionRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
pub struct PermissionStatus {
    platform: &'static str,
    screen_capture: bool,
    accessibility: bool,
    administrator: bool,
}

const VISION_READY_BAR_HEIGHT: f64 = 56.0;
const VISION_FLOATING_GAP: f64 = 8.0;
const VISION_ANSWER_MIN_HEIGHT: f64 = 180.0;
const VISION_CHAT_MIN_HEIGHT: f64 =
    VISION_READY_BAR_HEIGHT + VISION_FLOATING_GAP + VISION_ANSWER_MIN_HEIGHT;

fn set_vision_floating_size_constraints(
    window: &WebviewWindow,
    minimum_answer_height: bool,
) -> Result<(), String> {
    window
        .set_size_constraints(WindowSizeConstraints {
            min_width: None,
            min_height: minimum_answer_height
                .then(|| PixelUnit::new(LogicalUnit::new(VISION_CHAT_MIN_HEIGHT))),
            max_width: None,
            max_height: None,
        })
        .map_err(|error| error.to_string())
}

fn current_screen_space(app: &AppHandle) -> Option<crate::vision::ScreenSpace> {
    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let right = position.x + size.width as i32;
        let bottom = position.y + size.height as i32;
        (cursor.x as i32) >= position.x
            && (cursor.x as i32) < right
            && (cursor.y as i32) >= position.y
            && (cursor.y as i32) < bottom
    })?;
    let position = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    Some(crate::vision::ScreenSpace {
        scale: if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        },
        left: position.x,
        top: position.y,
        right: position.x + size.width as i32,
        bottom: position.y + size.height as i32,
    })
}

fn position_vision_fullscreen(window: &WebviewWindow, screen: crate::vision::ScreenSpace) {
    let _ = window.set_position(tauri::LogicalPosition::new(
        screen.left as f64 / screen.scale,
        screen.top as f64 / screen.scale,
    ));
    let _ = window.set_size(tauri::LogicalSize::new(
        (screen.right - screen.left) as f64 / screen.scale,
        (screen.bottom - screen.top) as f64 / screen.scale,
    ));
}

fn show_native_freeze(
    window: &WebviewWindow,
    screen: crate::vision::ScreenSpace,
) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = crate::native_freeze::show(screen);
            if result.is_ok() {
                crate::platform::windows::overlay_identity::apply(
                    screen.left,
                    screen.top,
                    screen.right,
                    screen.bottom,
                );
            }
            let _ = sender.send(result);
        })
        .map_err(|error| format!("schedule native freeze overlay failed: {error}"))?;
    receiver
        .recv_timeout(Duration::from_millis(1200))
        .map_err(|error| format!("native freeze overlay timed out on main thread: {error}"))?
}

fn close_native_freeze(app: &AppHandle) {
    request_native_freeze_close();
    let Some(window) = app.get_webview_window("vision") else {
        crate::native_freeze::close();
        request_native_freeze_close();
        return;
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    if window
        .run_on_main_thread(move || {
            crate::native_freeze::close();
            let _ = sender.send(());
        })
        .is_ok()
    {
        if receiver.recv_timeout(Duration::from_millis(800)).is_err() {
            request_native_freeze_close();
        }
    } else {
        request_native_freeze_close();
    }
    request_native_freeze_close();
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn close_freeze_window(
    hwnd: windows::Win32::Foundation::HWND,
    process: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowThreadProcessId, PostMessageW, SendMessageTimeoutW,
        SMTO_ABORTIFHUNG, WM_CLOSE,
    };
    let mut owner = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut owner));
    }
    if owner == process.0 as u32 {
        let mut class_name = [0u16; 64];
        let length = unsafe { GetClassNameW(hwnd, &mut class_name) };
        if length > 0
            && String::from_utf16_lossy(&class_name[..length as usize])
                == "ScreenPilotFreezeOverlay"
        {
            let mut message_result = 0usize;
            let closed = unsafe {
                SendMessageTimeoutW(
                    hwnd,
                    WM_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    250,
                    Some(&mut message_result),
                )
            };
            if closed.0 == 0 {
                let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            }
        }
    }
    windows::core::BOOL(1)
}

#[cfg(target_os = "windows")]
fn request_native_freeze_close() {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
    let _ = unsafe {
        EnumWindows(
            Some(close_freeze_window),
            LPARAM(std::process::id() as isize),
        )
    };
}

#[cfg(not(target_os = "windows"))]
fn request_native_freeze_close() {}

pub fn open_reference_vision(app: &AppHandle, mode: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let existing_vision_visible = app
        .get_webview_window("vision")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !existing_vision_visible {
        close_native_freeze(app);
    }
    if state.begin_vision() {
        let visible = app
            .get_webview_window("vision")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        if visible {
            return Err("Vision already active".into());
        }
        state.release_vision();
        let _ = state.begin_vision();
    }
    let result = (|| {
        let window = ensure_reference_vision_window(app, mode)?;
        let screen = current_screen_space(app).ok_or("No display is available")?;
        window
            .set_resizable(false)
            .map_err(|error| error.to_string())?;
        set_vision_floating_size_constraints(&window, false)?;
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        apply_vision_window_region(&window, None)?;
        show_native_freeze(&window, screen)?;
        let mode = if mode == "translate" {
            "translate"
        } else {
            "chat"
        };
        let script = format!(
            "window.location.hash = '#vision?mode={mode}'; window.dispatchEvent(new HashChangeEvent('hashchange')); window.dispatchEvent(new CustomEvent('vision:reset'));"
        );
        let _ = window.eval(&script);
        window
            .emit("screenpilot:reset", "vision")
            .map_err(|error| error.to_string())?;
        position_vision_fullscreen(&window, screen);
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        position_vision_fullscreen(&window, screen);
        let window_for_task = window.clone();
        let _ = window.run_on_main_thread(move || {
            crate::native_freeze::place_vision_above(&window_for_task);
        });
        Ok(())
    })();
    if result.is_err() {
        close_native_freeze(app);
        state.release_vision();
    }
    result
}

fn ensure_reference_vision_window(app: &AppHandle, mode: &str) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("vision") {
        return Ok(window);
    }
    let mode = if mode == "translate" {
        "translate"
    } else {
        "chat"
    };
    WebviewWindowBuilder::new(
        app,
        "vision",
        WebviewUrl::App(format!("index.html?window=vision#vision?mode={mode}").into()),
    )
    .title("ScreenPilot Vision")
    .visible(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .resizable(false)
    .inner_size(640.0, 520.0)
    .data_directory(app.state::<AppState>().webview_data_directory.clone())
    .build()
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn vision_request(app: AppHandle) -> Result<(), String> {
    open_reference_vision(&app, "chat")
}

#[tauri::command]
pub fn vision_request_translate(app: AppHandle) -> Result<(), String> {
    open_reference_vision(&app, "translate")
}

#[tauri::command]
pub fn vision_cursor_position(app: AppHandle) -> Option<Value> {
    let cursor = app.cursor_position().ok()?;
    let scale = current_screen_space(&app)
        .map(|screen| screen.scale)
        .unwrap_or(1.0);
    Some(json!({ "x": cursor.x / scale, "y": cursor.y / scale }))
}

#[tauri::command]
pub fn vision_list_windows(app: AppHandle) -> Vec<crate::vision::WindowInfo> {
    crate::vision::list_windows(current_screen_space(&app))
}

#[tauri::command]
pub fn vision_capture_window(window_id: u32) -> Value {
    match crate::vision::capture_window(window_id) {
        Ok(_) => {
            json!({ "success": false, "error": "Window capture must use the frozen region on Windows" })
        }
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn vision_capture_region(
    app: AppHandle,
    state: State<'_, AppState>,
    absolute_x: i32,
    absolute_y: i32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Value {
    let result = match crate::native_freeze::capture_active_region_to_png(
        absolute_x, absolute_y, width, height,
    ) {
        Ok(path) => {
            close_native_freeze(&app);
            Ok(path)
        }
        Err(_) => {
            close_native_freeze(&app);
            capture_region_image(
                absolute_x,
                absolute_y,
                x,
                y,
                width,
                height,
                scale_factor,
                None,
            )
        }
    };
    match result.and_then(|path| register_capture_path(&state, &path)) {
        Ok(image_id) => json!({ "success": true, "imageId": image_id }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

fn register_capture_path(state: &AppState, path: &Path) -> Result<String, String> {
    let image = image::open(path)
        .map(image::DynamicImage::into_rgba8)
        .map_err(|error| error.to_string());
    crate::screenshot::cleanup_temp_file(path);
    state.images.save_temporary(&image?)
}

#[allow(clippy::too_many_arguments)]
fn capture_region_image(
    absolute_x: i32,
    absolute_y: i32,
    _x: i32,
    _y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    _exclude_self_pid: Option<i32>,
) -> Result<PathBuf, String> {
    let sf = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let estimated_px = ((absolute_x as f64) * sf).round() as i32;
    let estimated_py = ((absolute_y as f64) * sf).round() as i32;
    let monitor = Monitor::from_point(estimated_px, estimated_py).or_else(|_| {
        Monitor::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|monitor| {
                let Ok(monitor_x) = monitor.x() else {
                    return false;
                };
                let Ok(monitor_y) = monitor.y() else {
                    return false;
                };
                let Ok(monitor_width) = monitor.width() else {
                    return false;
                };
                let Ok(monitor_height) = monitor.height() else {
                    return false;
                };
                let right = monitor_x + monitor_width as i32;
                let bottom = monitor_y + monitor_height as i32;
                estimated_px >= monitor_x
                    && estimated_px < right
                    && estimated_py >= monitor_y
                    && estimated_py < bottom
            })
            .ok_or_else(|| "No monitor found at the given position".to_string())
    })?;
    let monitor_x = monitor.x().map_err(|error| error.to_string())?;
    let monitor_y = monitor.y().map_err(|error| error.to_string())?;
    let monitor_scale = monitor.scale_factor().map_err(|error| error.to_string())? as f64;
    let absolute_physical_x = ((absolute_x as f64) * monitor_scale).round() as i32;
    let absolute_physical_y = ((absolute_y as f64) * monitor_scale).round() as i32;
    let relative_x = absolute_physical_x - monitor_x;
    let relative_y = absolute_physical_y - monitor_y;
    let region_width = ((width as f64) * monitor_scale).round() as u32;
    let region_height = ((height as f64) * monitor_scale).round() as u32;
    let monitor_width = monitor.width().map_err(|error| error.to_string())?;
    let monitor_height = monitor.height().map_err(|error| error.to_string())?;
    if relative_x < 0
        || relative_y < 0
        || region_width == 0
        || region_height == 0
        || relative_x as u32 >= monitor_width
        || relative_y as u32 >= monitor_height
    {
        return Err("Invalid capture region".to_string());
    }
    let capture_width = region_width
        .min(monitor_width.saturating_sub(relative_x as u32))
        .max(1);
    let capture_height = region_height
        .min(monitor_height.saturating_sub(relative_y as u32))
        .max(1);
    let image = monitor
        .capture_region(
            relative_x as u32,
            relative_y as u32,
            capture_width,
            capture_height,
        )
        .map_err(|error| error.to_string())?;
    let path = std::env::temp_dir().join(format!("screenshot-{}.png", Uuid::new_v4()));
    image.save(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn explain_read_image(state: State<'_, AppState>, image_id: String) -> Value {
    match state.images.read_data_url(&image_id) {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
pub fn vision_register_annotated_image(state: State<'_, AppState>, base64_png: String) -> Value {
    let result = STANDARD
        .decode(base64_png)
        .map_err(|error| error.to_string())
        .and_then(|bytes| image::load_from_memory(&bytes).map_err(|error| error.to_string()))
        .and_then(|image| state.images.save_temporary(&image.into_rgba8()));
    match result {
        Ok(image_id) => json!({ "success": true, "imageId": image_id }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
pub fn vision_commit_image_to_history(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<(), String> {
    state.images.commit(&image_id)
}

#[tauri::command]
pub fn vision_delete_history_image(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<(), String> {
    state.images.delete(&image_id)
}

#[tauri::command]
pub fn vision_close(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.begin_surface_action();
    let result = close_reference_vision_surface(&app);
    state.cancel_reference_vision_stream();
    state.release_vision();
    result
}

pub fn close_reference_vision_surface(app: &AppHandle) -> Result<(), String> {
    let mut failures = Vec::new();
    close_native_freeze(app);
    if let Some(window) = app.get_webview_window("vision") {
        if let Err(error) = window.set_ignore_cursor_events(false) {
            failures.push(error.to_string());
        }
        if let Err(error) = window.hide() {
            failures.push(error.to_string());
        }
        if let Err(error) = apply_vision_window_region(&window, None) {
            failures.push(error);
        }
        if let Err(error) = window.set_resizable(false) {
            failures.push(error.to_string());
        }
        if let Err(error) = set_vision_floating_size_constraints(&window, false) {
            failures.push(error);
        }
    }
    close_native_freeze(app);
    let state = app.state::<AppState>();
    state.cancel_reference_vision_stream();
    state.release_vision();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn apply_floating_rect(window: &WebviewWindow, rect: &FloatingRect) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };

        if let Ok(hwnd) = window.hwnd() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let width = (rect.width * scale).round() as i32;
            let height = (rect.height * scale).round() as i32;
            if rect.x.is_none() && rect.y.is_none() {
                if let Ok(current) = window.inner_size() {
                    if floating_size_matches(current.width, current.height, width, height) {
                        return Ok(());
                    }
                }
            }
            let mut flags = floating_window_pos_flags();
            let (x, y) = match (rect.x, rect.y) {
                (Some(x), Some(y)) => ((x * scale).round() as i32, (y * scale).round() as i32),
                _ => {
                    flags |= SWP_NOMOVE;
                    (0, 0)
                }
            };

            unsafe {
                if rect.x.is_none() && rect.y.is_none() {
                    let mut current = windows::Win32::Foundation::RECT::default();
                    if GetWindowRect(hwnd, &mut current).is_ok()
                        && (current.right - current.left - width).abs() <= 2
                        && (current.bottom - current.top - height).abs() <= 2
                    {
                        flags |= SWP_NOSIZE;
                    }
                }
                if SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, flags).is_ok() {
                    if let Some(hit_region) = rect.hit_region {
                        apply_vision_window_region(window, Some(hit_region))?;
                    }
                    return Ok(());
                }
            }
        }
    }

    if let (Some(x), Some(y)) = (rect.x, rect.y) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    let _ = window.set_size(tauri::LogicalSize::new(rect.width, rect.height));
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_floating_window_chrome(window: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let border_color = DWMWA_COLOR_NONE;
        let corner_preference = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::from_ref(&border_color).cast(),
            std::mem::size_of_val(&border_color) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&corner_preference).cast(),
            std::mem::size_of_val(&corner_preference) as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_floating_window_chrome(_window: &WebviewWindow) {}

fn floating_height_for_stage(height: f64, screenshot_translation: bool, positioned: bool) -> f64 {
    if !screenshot_translation {
        return height;
    }

    height.min(if positioned { 224.0 } else { TRANSLATOR_HEIGHT })
}

fn floating_size_matches(current_width: u32, current_height: u32, width: i32, height: i32) -> bool {
    (i64::from(current_width) - i64::from(width)).abs() <= 1
        && (i64::from(current_height) - i64::from(height)).abs() <= 1
}

fn validate_floating_fly_rect(rect: &FloatingFlyRect) -> Result<(), String> {
    if !rect.from.x.is_finite()
        || !rect.from.y.is_finite()
        || !rect.to.x.is_finite()
        || !rect.to.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("Invalid floating fly rect".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn ease_out_cubic(t: f64) -> f64 {
    let inv = 1.0 - t;
    1.0 - inv * inv * inv
}

fn apply_floating_fly_rect(window: &WebviewWindow, rect: &FloatingFlyRect) -> Result<(), String> {
    validate_floating_fly_rect(rect)?;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::DwmFlush;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOSIZE};

        if let Ok(hwnd) = window.hwnd() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let width = (rect.width * scale).round() as i32;
            let height = (rect.height * scale).round() as i32;
            let from_x = (rect.from.x * scale).round() as i32;
            let from_y = (rect.from.y * scale).round() as i32;
            let to_x = (rect.to.x * scale).round() as i32;
            let to_y = (rect.to.y * scale).round() as i32;
            let flags = floating_window_pos_flags();

            unsafe {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    from_x,
                    from_y,
                    width,
                    height,
                    flags,
                )
                .map_err(|error| format!("SetWindowPos(start) failed: {error}"))?;
            }

            if from_x == to_x && from_y == to_y {
                return Ok(());
            }

            let duration_ms = rect.duration_ms.unwrap_or(260).clamp(80, 600);
            let duration = Duration::from_millis(duration_ms);
            let started = Instant::now();
            let mut last_x = from_x;
            let mut last_y = from_y;

            loop {
                let linear =
                    (started.elapsed().as_secs_f64() / duration.as_secs_f64()).clamp(0.0, 1.0);
                let eased = ease_out_cubic(linear);
                let next_x = (from_x as f64 + (to_x - from_x) as f64 * eased).round() as i32;
                let next_y = (from_y as f64 + (to_y - from_y) as f64 * eased).round() as i32;

                if next_x != last_x || next_y != last_y || linear >= 1.0 {
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            Some(HWND_TOPMOST),
                            next_x,
                            next_y,
                            0,
                            0,
                            flags | SWP_NOSIZE,
                        )
                        .map_err(|error| format!("SetWindowPos(frame) failed: {error}"))?;
                    }
                    last_x = next_x;
                    last_y = next_y;
                }

                if linear >= 1.0 {
                    break;
                }

                let flushed = unsafe { DwmFlush().is_ok() };
                if !flushed {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }

            return Ok(());
        }
    }

    let final_rect = FloatingRect {
        x: Some(rect.to.x),
        y: Some(rect.to.y),
        width: rect.width,
        height: rect.height,
        hit_region: None,
    };
    apply_floating_rect(window, &final_rect)
}

#[tauri::command]
pub fn vision_set_floating(app: AppHandle, rect: FloatingRect) -> Result<(), String> {
    close_native_freeze(&app);
    if let Some(window) = app.get_webview_window("vision") {
        let screenshot_translation = window
            .url()
            .map_err(|error| error.to_string())?
            .fragment()
            .is_some_and(|fragment| fragment.contains("mode=translate"));
        let positioned = rect.x.is_some() && rect.y.is_some();
        let rect = FloatingRect {
            height: floating_height_for_stage(rect.height, screenshot_translation, positioned),
            ..rect
        };
        let resizable = vision_floating_resizable(screenshot_translation, rect.height);
        window
            .set_resizable(resizable)
            .map_err(|error| error.to_string())?;
        set_vision_floating_size_constraints(&window, resizable)?;
        apply_floating_window_chrome(&window);
        apply_floating_rect(&window, &rect)?;
    }
    Ok(())
}

fn vision_floating_resizable(screenshot_translation: bool, height: f64) -> bool {
    !screenshot_translation && height > 96.0
}

#[cfg(target_os = "windows")]
fn floating_window_pos_flags() -> windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS {
    use windows::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOOWNERZORDER};

    SWP_NOACTIVATE | SWP_NOOWNERZORDER
}

#[tauri::command]
pub fn vision_fly_floating(app: AppHandle, rect: FloatingFlyRect) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("vision") {
        let screenshot_translation = window
            .url()
            .map_err(|error| error.to_string())?
            .fragment()
            .is_some_and(|fragment| fragment.contains("mode=translate"));
        let rect = FloatingFlyRect {
            height: floating_height_for_stage(rect.height, screenshot_translation, true),
            ..rect
        };
        apply_floating_fly_rect(&window, &rect)?;
    }
    Ok(())
}

fn apply_vision_window_region(
    window: &WebviewWindow,
    rect: Option<HitRegionRect>,
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let Some(rect) = rect else {
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err("SetWindowRgn(clear) failed".into());
            }
            return Ok(());
        };
        if !rect.x.is_finite()
            || !rect.y.is_finite()
            || !rect.width.is_finite()
            || !rect.height.is_finite()
            || rect.width <= 0.0
            || rect.height <= 0.0
        {
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err("SetWindowRgn(clear invalid) failed".into());
            }
            return Ok(());
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let x1 = (rect.x * scale).floor() as i32;
        let y1 = (rect.y * scale).floor() as i32;
        let x2 = ((rect.x + rect.width) * scale).ceil() as i32;
        let y2 = ((rect.y + rect.height) * scale).ceil() as i32;
        if x2 <= x1 || y2 <= y1 {
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err("SetWindowRgn(clear empty) failed".into());
            }
            return Ok(());
        }
        let region = CreateRectRgn(x1, y1, x2, y2);
        if region.is_invalid() {
            return Err("CreateRectRgn failed".into());
        }
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("SetWindowRgn failed".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn vision_set_hit_region(app: AppHandle, rect: Option<HitRegionRect>) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("vision") {
        apply_vision_window_region(&window, rect)?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn vision_set_ignore_cursor_events(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("vision") {
        window
            .set_ignore_cursor_events(ignore)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn take_vision_selection(state: State<'_, AppState>) -> String {
    state.take_vision_selection()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current()?;
    let providers = settings
        .providers
        .iter()
        .map(|provider| {
            Ok(json!({
                "id": provider.id,
                "name": provider.name,
                "apiKeys": CredentialVault::provider_keys(&provider.id)?,
                "baseUrl": provider.base_url,
                "availableModels": provider.available_models,
                "enabledModels": provider.enabled_models,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let ocr_keys = CredentialVault::provider_keys("adapter-baidu-ocr")?;
    let baidu_keys = CredentialVault::provider_keys("adapter-baidu-translation")?;
    let tencent_keys = CredentialVault::provider_keys("adapter-tencent-translation")?;
    let caiyun_keys = CredentialVault::provider_keys("adapter-caiyun-translation")?;
    let (translator_provider, translator_model) = model_parts(&settings.translation.ai_model);
    let (ocr_provider, ocr_model) = model_parts(&settings.screenshot_translation.ocr_model);
    let (translate_provider, translate_model) =
        model_parts(&settings.screenshot_translation.translation_model);
    let (vision_provider, vision_model) = model_parts(&settings.vision.model);
    let (optimizer_provider, optimizer_model) = model_parts(&settings.prompt_optimizer.model);
    Ok(json!({
        "hotkey": settings.shortcuts.translator,
        "theme": settings.theme,
        "targetLang": settings.translation.target_language,
        "source": "auto",
        "autoPaste": settings.general.auto_paste,
        "launchAtStartup": settings.general.launch_at_startup,
        "launchAtStartupAsAdmin": settings.general.launch_at_startup_as_administrator,
        "translatorProviderId": translator_provider,
        "translatorModel": translator_model,
        "translatorPrompt": settings.translation.prompt,
        "providers": providers,
        "retryEnabled": settings.retry.enabled,
        "retryAttempts": settings.retry.attempts,
        "screenshotTranslation": {
            "enabled": settings.screenshot_translation.enabled,
            "targetLanguage": settings.screenshot_translation.target_language,
            "hotkey": settings.shortcuts.screenshot_translation,
            "providerId": ocr_provider,
            "model": ocr_model,
            "ocrMethod": settings.screenshot_translation.ocr_method,
            "translationMethod": settings.screenshot_translation.translation_method,
            "translateProviderId": translate_provider,
            "translateModel": translate_model,
            "baiduOcr": {
                "apiKey": secret_at(&ocr_keys, 0),
                "secretKey": secret_at(&ocr_keys, 1)
            },
            "baiduTranslate": {
                "appId": secret_at(&baidu_keys, 0),
                "appKey": secret_at(&baidu_keys, 1)
            },
            "tencentTranslate": {
                "secretId": secret_at(&tencent_keys, 0),
                "secretKey": secret_at(&tencent_keys, 1)
            },
            "caiyunTranslate": { "token": secret_at(&caiyun_keys, 0) },
            "directTranslate": !settings.screenshot_translation.show_source,
            "thinkingEnabled": settings.screenshot_translation.thinking,
            "thinkingEffort": settings.screenshot_translation.thinking_effort,
            "streamEnabled": settings.screenshot_translation.stream,
            "keepFullscreenAfterCapture": false,
            "useSystemOcr": settings.screenshot_translation.ocr_method == OcrMethod::System,
            "ocrPrompt": settings.screenshot_translation.ocr_prompt,
            "prompt": settings.screenshot_translation.translation_prompt,
        },
        "vision": {
            "enabled": settings.vision.enabled,
            "hotkey": settings.shortcuts.vision,
            "providerId": vision_provider,
            "model": vision_model,
            "defaultLanguage": settings.vision.response_language,
            "streamEnabled": settings.vision.stream,
            "thinkingEnabled": settings.vision.thinking,
            "thinkingEffort": settings.vision.thinking_effort,
            "webSearchEnabled": settings.vision.web_search,
            "systemPrompt": settings.vision.system_prompt,
            "questionPrompt": settings.vision.question_prompt,
            "messageOrder": settings.vision.message_order,
            "keepFullscreenAfterCapture": false,
        },
        "promptOptimizer": {
            "enabled": settings.prompt_optimizer.enabled,
            "hotkey": settings.shortcuts.prompt_optimizer,
            "providerId": optimizer_provider,
            "model": optimizer_model,
            "defaultLanguage": settings.prompt_optimizer.response_language,
            "systemPrompt": settings.prompt_optimizer.system_prompt,
            "optimizePrompt": settings.prompt_optimizer.optimize_prompt,
        },
        "settingsLanguage": settings.language,
        "autoCheckUpdate": false,
        "imageArchiveEnabled": settings.general.image_archive_enabled,
        "imageArchivePath": settings.general.image_archive_path,
    }))
}

fn model_parts(selection: &Option<ModelSelection>) -> (&str, &str) {
    selection
        .as_ref()
        .map(|selection| (selection.provider_id.as_str(), selection.model.as_str()))
        .unwrap_or(("", ""))
}

fn secret_at(values: &[String], index: usize) -> &str {
    values.get(index).map(String::as_str).unwrap_or("")
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Value) -> Result<(), String> {
    let _settings_write = state.lock_settings_write()?;
    let mut current = state.current()?;
    apply_screenshot_settings_patch(&mut current, &settings)?;
    state.store.save(&current)?;
    state.replace(&current)
}

fn apply_screenshot_settings_patch(
    current: &mut AppSettings,
    settings: &Value,
) -> Result<(), String> {
    let screenshot = settings
        .get("screenshotTranslation")
        .ok_or("Screenshot settings are missing")?;
    if let Some(method) = screenshot.get("ocrMethod").and_then(Value::as_str) {
        current.screenshot_translation.ocr_method = parse_ocr_method(method)?;
    }
    if let Some(method) = screenshot.get("translationMethod").and_then(Value::as_str) {
        current.screenshot_translation.translation_method = parse_translation_method(method)?;
    }
    if let Some(target_language) = screenshot.get("targetLanguage").and_then(Value::as_str) {
        validate_screenshot_target_language(target_language)?;
        current.screenshot_translation.target_language = target_language.to_string();
    }
    if let Some(show_source) = screenshot.get("directTranslate").and_then(Value::as_bool) {
        current.screenshot_translation.show_source = !show_source;
    }
    update_model_selection(
        &mut current.screenshot_translation.ocr_model,
        screenshot.get("providerId").and_then(Value::as_str),
        screenshot.get("model").and_then(Value::as_str),
    );
    update_model_selection(
        &mut current.screenshot_translation.translation_model,
        screenshot
            .get("translateProviderId")
            .and_then(Value::as_str),
        screenshot.get("translateModel").and_then(Value::as_str),
    );
    current.validate()
}

fn update_model_selection(
    selection: &mut Option<ModelSelection>,
    provider: Option<&str>,
    model: Option<&str>,
) {
    if let (Some(provider_id), Some(model)) = (provider, model) {
        *selection = if provider_id.trim().is_empty() || model.trim().is_empty() {
            None
        } else {
            Some(ModelSelection {
                provider_id: provider_id.to_string(),
                model: model.to_string(),
            })
        };
    }
}

fn parse_ocr_method(value: &str) -> Result<OcrMethod, String> {
    match value {
        "ai" => Ok(OcrMethod::Ai),
        "baidu" => Ok(OcrMethod::Baidu),
        "chaoxing" => Ok(OcrMethod::Chaoxing),
        "system" => Ok(OcrMethod::System),
        _ => Err("Unsupported OCR method".into()),
    }
}

fn parse_translation_method(value: &str) -> Result<TranslationMethod, String> {
    match value {
        "ai" => Ok(TranslationMethod::Ai),
        "baidu" => Ok(TranslationMethod::Baidu),
        "google" => Ok(TranslationMethod::Google),
        "tencent" => Ok(TranslationMethod::Tencent),
        "bing" => Ok(TranslationMethod::Bing),
        "bing2" => Ok(TranslationMethod::Bing2),
        "yandex" => Ok(TranslationMethod::Yandex),
        "caiyun2" => Ok(TranslationMethod::Caiyun2),
        "microsoft" => Ok(TranslationMethod::Microsoft),
        _ => Err("Unsupported translation method".into()),
    }
}

#[tauri::command]
pub async fn vision_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    image_id: String,
    messages: Vec<ExplainMessage>,
) -> Result<Value, String> {
    Ok(
        match run_vision_request(&app, &state, &image_id, &messages).await {
            Ok(Some(response)) => json!({ "success": true, "response": response }),
            Ok(None) => json!({ "success": true }),
            Err(error) => json!({ "success": false, "error": error }),
        },
    )
}

async fn run_vision_request(
    app: &AppHandle,
    state: &AppState,
    image_id: &str,
    messages: &[ExplainMessage],
) -> Result<Option<String>, String> {
    let settings = state.current()?;
    let selection = settings
        .vision
        .model
        .as_ref()
        .ok_or("Select a Vision model in settings")?;
    let (provider, keys) = provider_and_keys(&settings, selection)?;
    let image_url = if image_id.is_empty() {
        None
    } else {
        Some(state.images.read_data_url(image_id)?)
    };
    let mut prepared_messages = messages.to_vec();
    if !image_id.is_empty() && !settings.vision.question_prompt.trim().is_empty() {
        if let Some(last_user) = prepared_messages
            .iter_mut()
            .rev()
            .find(|message| message.role == "user")
        {
            last_user.content = format!(
                "{}\n\n用户问题：{}",
                settings.vision.question_prompt, last_user.content
            );
        }
    }
    let ai_messages = prepared_messages
        .iter()
        .map(|message| AiMessage {
            role: &message.role,
            content: &message.content,
        })
        .collect::<Vec<_>>();
    let policy = AiRequestPolicy::new(
        settings.retry.enabled,
        settings.retry.attempts,
        settings.vision.stream,
    );
    state.begin_reference_vision_stream();
    if settings.vision.stream {
        let event_image_id = image_id.to_string();
        let finish = stream_vision(
            VisionCompletion {
                provider,
                model: &selection.model,
                keys: &keys,
                system: &settings.vision.system_prompt,
                messages: &ai_messages,
                image_url: image_url.as_deref(),
                policy,
            },
            |delta| {
                let payload = match delta {
                    SseDelta::Text(delta) => json!({
                        "imageId": event_image_id,
                        "kind": "answer",
                        "delta": delta,
                    }),
                    SseDelta::Reasoning(delta) => json!({
                        "imageId": event_image_id,
                        "kind": "answer",
                        "delta": "",
                        "reasoningDelta": delta,
                    }),
                    SseDelta::Done | SseDelta::Error(_) => return Ok(()),
                };
                app.emit_to("vision", "vision-stream", payload)
                    .map_err(|error| error.to_string())
            },
            || state.reference_vision_stream_cancelled(),
        )
        .await?;
        let reason = if finish == AiStreamFinish::Done {
            "done"
        } else {
            "cancelled"
        };
        app.emit_to(
            "vision",
            "vision-stream",
            json!({
                "imageId": image_id,
                "kind": "answer",
                "delta": "",
                "done": true,
                "reason": reason,
            }),
        )
        .map_err(|error| error.to_string())?;
        Ok(None)
    } else {
        complete_vision(
            provider,
            &selection.model,
            &keys,
            &settings.vision.system_prompt,
            &ai_messages,
            image_url.as_deref(),
            policy,
        )
        .await
        .map(Some)
    }
}

#[tauri::command]
pub fn vision_cancel_stream(state: State<'_, AppState>) {
    state.cancel_reference_vision_stream();
}

#[tauri::command]
pub async fn vision_translate(
    app: AppHandle,
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Value, String> {
    state.begin_reference_vision_stream();
    let result = match recognize_screenshot(&state, &image_id).await {
        Ok(source) => async_translation(&state, source).await,
        Err(error) => Err(error),
    };
    Ok(match result {
        Ok((source, translated)) => {
            let _ = arboard::Clipboard::new()
                .and_then(|mut clipboard| clipboard.set_text(source.clone()));
            let _ = app.emit_to(
                "vision",
                "vision-translate-stream",
                json!({ "imageId": image_id, "kind": "original", "delta": source }),
            );
            let _ = app.emit_to(
                "vision",
                "vision-translate-stream",
                json!({ "imageId": image_id, "kind": "translated", "delta": translated }),
            );
            let _ = app.emit_to(
                "vision",
                "vision-translate-stream",
                json!({ "imageId": image_id, "done": true, "success": true }),
            );
            json!({ "success": true })
        }
        Err(error) => json!({ "success": false, "error": error }),
    })
}

async fn async_translation(state: &AppState, source: String) -> Result<(String, String), String> {
    let translated = translate_source(state, &source, None).await?;
    Ok((source, translated))
}

#[tauri::command]
pub async fn vision_translate_text(
    state: State<'_, AppState>,
    text: String,
    target_language: Option<String>,
) -> Result<Value, String> {
    Ok(
        match translate_source(&state, &text, target_language.as_deref()).await {
            Ok(translated) => json!({ "success": true, "translated": translated }),
            Err(error) => json!({ "success": false, "error": error }),
        },
    )
}

async fn recognize_screenshot(state: &AppState, image_id: &str) -> Result<String, String> {
    let settings = state.current()?;
    match settings.screenshot_translation.ocr_method {
        OcrMethod::Ai => {
            let selection = settings
                .screenshot_translation
                .ocr_model
                .as_ref()
                .or(settings.vision.model.as_ref())
                .ok_or("Select an AI OCR model in settings")?;
            let (provider, keys) = provider_and_keys(&settings, selection)?;
            let image_url = state.images.read_data_url(image_id)?;
            complete_vision(
                provider,
                &selection.model,
                &keys,
                &settings.screenshot_translation.ocr_prompt,
                &[AiMessage {
                    role: "user",
                    content: "Recognize the visible content in this image.",
                }],
                Some(&image_url),
                AiRequestPolicy::new(settings.retry.enabled, settings.retry.attempts, false),
            )
            .await
        }
        OcrMethod::Chaoxing => ocr::chaoxing(&state.images.read_bytes(image_id)?).await,
        OcrMethod::Baidu => {
            let credentials = CredentialVault::provider_keys("adapter-baidu-ocr")?;
            ocr::baidu(&state.images.read_bytes(image_id)?, &credentials).await
        }
        OcrMethod::System => Err("System OCR is not available on Windows".into()),
    }
}

async fn translate_source(
    state: &AppState,
    source: &str,
    requested_target_language: Option<&str>,
) -> Result<String, String> {
    let settings = state.current()?;
    let target_language =
        requested_target_language.unwrap_or(&settings.screenshot_translation.target_language);
    validate_screenshot_target_language(target_language)?;
    let target_language = translation::resolve_target_language(source, target_language);
    if settings.screenshot_translation.translation_method == TranslationMethod::Ai {
        let selection = settings
            .screenshot_translation
            .translation_model
            .as_ref()
            .or(settings.translation.ai_model.as_ref())
            .ok_or("Select a screenshot translation model in settings")?;
        let (provider, keys) = provider_and_keys(&settings, selection)?;
        let prompt = build_screenshot_translation_prompt(
            source,
            screenshot_target_name(target_language),
            &settings.screenshot_translation.translation_prompt,
        );
        complete_text(
            provider,
            &selection.model,
            &keys,
            "",
            &prompt,
            AiRequestPolicy::new(settings.retry.enabled, settings.retry.attempts, false),
        )
        .await
    } else {
        let method = translation_method_name(settings.screenshot_translation.translation_method);
        let credential_id = match method {
            "baidu" => Some("adapter-baidu-translation"),
            "tencent" => Some("adapter-tencent-translation"),
            "caiyun2" => Some("adapter-caiyun-translation"),
            _ => None,
        };
        let credentials = credential_id
            .map(CredentialVault::provider_keys)
            .transpose()?
            .unwrap_or_default();
        translation::translate(method, source, target_language, &credentials).await
    }
}

fn build_screenshot_translation_prompt(source: &str, language: &str, template: &str) -> String {
    let trimmed = template.trim();
    let mut prompt = trimmed
        .replace("{lang}", language)
        .replace("{text}", source);
    if !trimmed.contains("{text}") {
        prompt.push_str("\n\n");
        prompt.push_str(source);
    }
    prompt
}

fn screenshot_target_name(target_language: &str) -> &'static str {
    match target_language {
        "zh-CN" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        _ => "the requested language",
    }
}

fn validate_screenshot_target_language(target_language: &str) -> Result<(), String> {
    if matches!(target_language, "auto" | "zh-CN" | "en" | "ja" | "ko") {
        Ok(())
    } else {
        Err("Unsupported screenshot translation target language".into())
    }
}

fn provider_and_keys<'a>(
    settings: &'a AppSettings,
    selection: &ModelSelection,
) -> Result<(&'a crate::domain::settings::ProviderSettings, Vec<String>), String> {
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == selection.provider_id)
        .ok_or("The selected provider no longer exists")?;
    let keys = CredentialVault::provider_keys(&provider.id)?;
    Ok((provider, keys))
}

fn translation_method_name(method: TranslationMethod) -> &'static str {
    match method {
        TranslationMethod::Ai => "ai",
        TranslationMethod::Baidu => "baidu",
        TranslationMethod::Google => "google",
        TranslationMethod::Tencent => "tencent",
        TranslationMethod::Bing => "bing",
        TranslationMethod::Bing2 => "bing2",
        TranslationMethod::Yandex => "yandex",
        TranslationMethod::Caiyun2 => "caiyun2",
        TranslationMethod::Microsoft => "microsoft",
    }
}

#[tauri::command]
pub async fn optimize_prompt(state: State<'_, AppState>, text: String) -> Result<String, String> {
    let settings = state.current()?;
    let selection = settings
        .prompt_optimizer
        .model
        .as_ref()
        .ok_or("Select a prompt optimizer model in settings")?;
    let (provider, keys) = provider_and_keys(&settings, selection)?;
    let language =
        optimizer_response_language_name(&settings.prompt_optimizer.response_language, &text);
    complete_text(
        provider,
        &selection.model,
        &keys,
        &settings.prompt_optimizer.system_prompt,
        &build_screenshot_translation_prompt(
            &text,
            language,
            &settings.prompt_optimizer.optimize_prompt,
        ),
        AiRequestPolicy::new(settings.retry.enabled, settings.retry.attempts, false),
    )
    .await
}

fn optimizer_response_language_name(language: &str, text: &str) -> &'static str {
    match language {
        "en" => "English",
        "zh-CN" => "Simplified Chinese",
        _ if text
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character)) =>
        {
            "Simplified Chinese"
        }
        _ => "English",
    }
}

#[tauri::command]
pub async fn synthesize_speech(app: AppHandle, text: String) -> Value {
    match synthesize_speech_data(app, text).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

async fn synthesize_speech_data(app: AppHandle, text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("Speech text is empty".into());
    }
    let path = app
        .state::<AppState>()
        .cache_directory
        .clone()
        .join(format!("screenpilot-speech-{}.wav", Uuid::new_v4()));
    std::fs::create_dir_all(&app.state::<AppState>().cache_directory)
        .map_err(|error| error.to_string())?;
    let spoken = text.chars().take(10_000).collect::<String>();
    let generated = path.clone();
    tokio::task::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        let script = "$voice=New-Object System.Speech.Synthesis.SpeechSynthesizer;$voice.SetOutputToWaveFile($env:SCREENPILOT_SPEECH_PATH);$voice.Speak($env:SCREENPILOT_SPEECH_TEXT);$voice.Dispose()";
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .env("SCREENPILOT_SPEECH_PATH", &generated)
            .env("SCREENPILOT_SPEECH_TEXT", spoken)
            .creation_flags(0x08000000)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Speech synthesis exited with code {:?}", status.code()))
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(path);
    Ok(format!("data:audio/wav;base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn permissions_status() -> PermissionStatus {
    PermissionStatus {
        platform: "windows",
        screen_capture: true,
        accessibility: true,
        administrator: unsafe { windows::Win32::UI::Shell::IsUserAnAdmin().as_bool() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_floating_fly_geometry() {
        let valid = FloatingFlyRect {
            from: FloatingPoint { x: 10.0, y: 20.0 },
            to: FloatingPoint { x: 30.0, y: 40.0 },
            width: 520.0,
            height: 300.0,
            duration_ms: Some(260),
        };
        assert!(validate_floating_fly_rect(&valid).is_ok());
        let invalid = FloatingFlyRect {
            width: 0.0,
            ..valid
        };
        assert_eq!(
            validate_floating_fly_rect(&invalid).unwrap_err(),
            "Invalid floating fly rect"
        );
    }

    #[test]
    fn defines_screenshot_translation_targets() {
        for language in ["auto", "zh-CN", "en", "ja", "ko"] {
            assert!(validate_screenshot_target_language(language).is_ok());
            assert!(!screenshot_target_name(language).is_empty());
        }
        assert!(validate_screenshot_target_language("unsupported").is_err());
        assert_eq!(screenshot_target_name("en"), "English");
    }

    #[test]
    fn expands_reference_screenshot_translation_placeholders() {
        assert_eq!(
            build_screenshot_translation_prompt("source", "English", "Translate to {lang}: {text}"),
            "Translate to English: source"
        );
        assert_eq!(
            build_screenshot_translation_prompt("source", "English", "Translate only"),
            "Translate only\n\nsource"
        );
    }

    #[test]
    fn vision_chat_only_allows_resizing_after_the_narrow_bar_expands() {
        assert!(!vision_floating_resizable(false, 56.0));
        assert!(!vision_floating_resizable(false, 96.0));
        assert!(vision_floating_resizable(false, 97.0));
        assert!(vision_floating_resizable(false, 520.0));
    }

    #[test]
    fn vision_chat_minimum_size_preserves_the_answer_surface() {
        assert_eq!(VISION_CHAT_MIN_HEIGHT, 244.0);
    }

    #[test]
    fn screenshot_translation_result_never_allows_window_resizing() {
        for height in [56.0, 96.0, 97.0, 188.0, 224.0, 420.0, 520.0] {
            assert!(!vision_floating_resizable(true, height));
        }
    }

    #[test]
    fn legacy_screenshot_patch_preserves_current_providers() {
        let mut settings = AppSettings::default();
        settings
            .providers
            .push(crate::domain::settings::ProviderSettings {
                id: "custom".into(),
                name: "Custom".into(),
                base_url: "https://example.com/v1".into(),
                key_count: 1,
                available_models: vec!["model-a".into()],
                enabled_models: vec!["model-a".into()],
            });
        let providers = settings.providers.clone();
        let payload = serde_json::json!({
            "providers": [],
            "screenshotTranslation": {
                "translationMethod": "ai",
                "translateProviderId": "custom",
                "translateModel": "model-a"
            }
        });
        apply_screenshot_settings_patch(&mut settings, &payload)
            .expect("valid legacy screenshot patch");
        assert_eq!(settings.providers, providers);
        assert_eq!(
            settings.screenshot_translation.translation_model,
            Some(ModelSelection {
                provider_id: "custom".into(),
                model: "model-a".into(),
            })
        );
    }

    #[test]
    fn screenshot_translation_starts_compact_and_caps_measured_height() {
        assert_eq!(floating_height_for_stage(420.0, true, true), 224.0);
        assert_eq!(floating_height_for_stage(188.0, true, true), 188.0);
        assert_eq!(floating_height_for_stage(188.0, true, false), 188.0);
        assert_eq!(
            floating_height_for_stage(TRANSLATOR_HEIGHT, true, false),
            TRANSLATOR_HEIGHT
        );
        assert_eq!(
            floating_height_for_stage(TRANSLATOR_HEIGHT + 120.0, true, false),
            TRANSLATOR_HEIGHT
        );
        assert_eq!(floating_height_for_stage(420.0, false, true), 420.0);
        assert_eq!(floating_height_for_stage(620.0, false, false), 620.0);
    }

    #[test]
    fn skips_native_resize_when_the_webview_already_matches() {
        assert!(floating_size_matches(480, 320, 480, 320));
        assert!(floating_size_matches(480, 320, 481, 319));
        assert!(!floating_size_matches(480, 320, 482, 320));
        assert!(!floating_size_matches(480, 320, 480, 318));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn floating_window_updates_are_allowed_to_reassert_topmost_order() {
        use windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER;

        assert_eq!(
            floating_window_pos_flags() & SWP_NOZORDER,
            Default::default()
        );
    }
}
