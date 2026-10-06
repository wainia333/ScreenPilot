//! A shared React popup replaces the OS menu so pin/tray menus look identical.
use super::{capture_runtime, lifecycle, state::AppState};
use crate::domain::settings::{AppSettings, InterfaceLanguage};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "tray-menu";
const EVENT: &str = "screenpilot:tray-menu";
const MENU_WIDTH: f64 = 286.0;
const MENU_SHADOW: f64 = 8.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    label: String,
    shortcut: String,
    enabled: bool,
    checked: Option<bool>,
    separator: bool,
}
impl Item {
    fn action(id: &str, label: &str, shortcut: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            shortcut: shortcut
                .replace("Control", "Ctrl")
                .replace("Meta", "Win")
                .replace('+', " + "),
            enabled: true,
            checked: None,
            separator: false,
        }
    }
    fn separator() -> Self {
        Self {
            separator: true,
            ..Self::action("", "", "")
        }
    }
}
pub fn items(settings: &AppSettings, pin_count: usize) -> Vec<Item> {
    let mut result = lifecycle::tray_feature_items(settings)
        .into_iter()
        .map(|(id, label, shortcut)| Item::action(id, label, shortcut))
        .collect::<Vec<_>>();
    let pin = Item {
        enabled: pin_count > 0,
        checked: Some(pin_count > 0 && settings.capture.pins_visible),
        ..Item::action(
            "pins",
            if settings.language == InterfaceLanguage::Zh {
                "显示 / 隐藏钉图"
            } else {
                "Show / Hide pins"
            },
            "",
        )
    };
    let position = result
        .iter()
        .position(|item| item.id == "capture")
        .map_or(result.len(), |index| index + 1);
    result.insert(position, pin);
    result.push(Item {
        enabled: settings.alt_snap.enabled,
        ..Item::action("altsnap", "AltSnap", &settings.alt_snap.shortcut)
    });
    let labels = lifecycle::tray_labels(settings.language);
    result.extend([
        Item::separator(),
        Item::action("settings", labels.settings, ""),
        Item::separator(),
        Item::action("restart_admin", labels.restart_admin, ""),
        Item::action("quit", labels.quit, ""),
    ]);
    result
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    generation: u64,
    items: Vec<Item>,
    scale: f64,
    accent: String,
}
#[derive(Clone)]
struct Request {
    generation: u64,
    x: i32,
    y: i32,
    screen: (i32, i32, i32, i32),
    dpi: f64,
}
#[derive(Default)]
struct PopupState {
    next: u64,
    pending: Option<Request>,
    presented: Option<u64>,
}
pub fn prepare(app: &AppHandle) -> Result<(), String> {
    app.manage(Mutex::new(PopupState::default()));
    WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?window=tray-menu".into()),
    )
    .title("ScreenPilot 菜单")
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .inner_size(310.0, 450.0)
    .data_directory(app.state::<AppState>().webview_data_directory.clone())
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn model(app: &AppHandle, request: &Request) -> Result<Model, String> {
    let settings = app.state::<AppState>().current()?;
    let items = items(&settings, capture_runtime::pin_count(app));
    let height = 18.0
        + items.iter().filter(|i| !i.separator).count() as f64 * 38.0
        + items.iter().filter(|i| i.separator).count() as f64 * 11.0;
    let percent = settings
        .capture
        .native_options
        .get("ui_scale_percent")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let desired = if percent > 0.0 {
        percent / 100.0
    } else if request.dpi > 1.5 {
        1.5
    } else if request.dpi > 1.0 {
        1.25
    } else {
        1.0
    };
    let scale = (desired / request.dpi)
        .min(
            (request.screen.2 - request.screen.0) as f64
                / request.dpi
                / (MENU_WIDTH + 2.0 * MENU_SHADOW),
        )
        .min(
            (request.screen.3 - request.screen.1) as f64
                / request.dpi
                / (height + 2.0 * MENU_SHADOW),
        )
        .max(0.01);
    Ok(Model {
        generation: request.generation,
        items,
        scale,
        accent: settings
            .capture
            .native_options
            .get("theme_color")
            .and_then(|v| v.as_str())
            .unwrap_or("#3388ff")
            .into(),
    })
}
pub fn open(app: &AppHandle, x: i32, y: i32) -> Result<(), String> {
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    };
    let mut monitor = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if !GetMonitorInfoW(
            MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
        .as_bool()
        {
            return Err("无法定位托盘菜单".into());
        }
    }
    let dpi = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|m| {
            m.position().x == monitor.rcMonitor.left && m.position().y == monitor.rcMonitor.top
        })
        .map_or(1.0, |m| m.scale_factor());
    let state = app.state::<Mutex<PopupState>>();
    let request = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.next += 1;
        let request = Request {
            generation: state.next,
            x,
            y,
            // Context menus can overlap the taskbar to stay beside its icon.
            // Bound the popup to the monitor, including its rounded shadow.
            screen: (
                monitor.rcMonitor.left,
                monitor.rcMonitor.top,
                monitor.rcMonitor.right,
                monitor.rcMonitor.bottom,
            ),
            dpi,
        };
        state.pending = Some(request.clone());
        state.presented = None;
        request
    };
    // Position while hidden so WebView2 sees the correct monitor DPI before measuring.
    let window = app.get_webview_window(LABEL).ok_or("托盘菜单不可用")?;
    window
        .set_position(PhysicalPosition::new(
            x.clamp(request.screen.0, request.screen.2 - 1),
            y.clamp(request.screen.1, request.screen.3 - 1),
        ))
        .map_err(|e| e.to_string())?;
    window
        .emit(EVENT, model(app, &request)?)
        .map_err(|e| e.to_string())
}
pub fn refresh(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<Mutex<PopupState>>() {
        let request = state.lock().map_err(|e| e.to_string())?.pending.clone();
        if let Some(request) = request {
            if let Some(window) = app.get_webview_window(LABEL) {
                window
                    .emit(EVENT, model(app, &request)?)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
pub fn dismiss(app: &AppHandle, generation: Option<u64>) -> Result<(), String> {
    let state = app.state::<Mutex<PopupState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if generation.is_some_and(|g| state.pending.as_ref().is_none_or(|p| p.generation != g)) {
        return Ok(());
    }
    state.pending = None;
    state.presented = None;
    drop(state);
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn dismiss_unfocused(app: &AppHandle) -> Result<(), String> {
    let generation = {
        let state = app.state::<Mutex<PopupState>>();
        let state = state.lock().map_err(|e| e.to_string())?;
        state
            .pending
            .as_ref()
            .filter(|r| state.presented == Some(r.generation))
            .map(|r| r.generation)
    };
    if let Some(generation) = generation {
        if let Some(window) = app.get_webview_window(LABEL) {
            // A delayed blur from hiding the previous popup must not cancel a
            // newly preparing request or a new popup that already has focus.
            if window.is_visible().map_err(|e| e.to_string())?
                && !window.is_focused().map_err(|e| e.to_string())?
            {
                dismiss(app, Some(generation))?;
            }
        }
    }
    Ok(())
}
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("此窗口无权操作托盘菜单".into())
    }
}
#[tauri::command]
pub fn tray_menu_snapshot(app: AppHandle, window: WebviewWindow) -> Result<Option<Model>, String> {
    authorize(&window)?;
    let request = app
        .state::<Mutex<PopupState>>()
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .clone();
    request.as_ref().map(|r| model(&app, r)).transpose()
}
pub fn popup_position(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    padding: i32,
    screen: (i32, i32, i32, i32),
) -> (i32, i32) {
    let above = y - height + padding;
    let top = if above >= screen.1 {
        above
    } else {
        y - padding
    };
    (
        // Anchor the visible edge directly beside the pointer. Flip below near
        // the monitor's top edge and keep the entire shadow inside the monitor.
        (x - padding).clamp(screen.0, (screen.2 - width).max(screen.0)),
        top.clamp(screen.1, (screen.3 - height).max(screen.1)),
    )
}
#[tauri::command]
pub fn tray_menu_ready(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    authorize(&window)?;
    if !width.is_finite()
        || !height.is_finite()
        || !(1.0..=2048.0).contains(&width)
        || !(1.0..=2048.0).contains(&height)
    {
        return Err("菜单尺寸无效".into());
    }
    let request = app
        .state::<Mutex<PopupState>>()
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .clone();
    let Some(request) = request.filter(|r| r.generation == generation) else {
        return Ok(());
    };
    let width = ((width * request.dpi).ceil() as i32).min(request.screen.2 - request.screen.0);
    let height = ((height * request.dpi).ceil() as i32).min(request.screen.3 - request.screen.1);
    let padding = (width as f64 * MENU_SHADOW / (MENU_WIDTH + 2.0 * MENU_SHADOW)).round() as i32;
    let (x, y) = popup_position(request.x, request.y, width, height, padding, request.screen);
    lifecycle::disable_capture_window_transitions(window.hwnd().map_err(|e| e.to_string())?)?;
    window
        .set_size(PhysicalSize::new(width as u32, height as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    if !window.is_visible().map_err(|e| e.to_string())? {
        window.show().map_err(|e| e.to_string())?;
    }
    window.set_focus().map_err(|e| e.to_string())?;
    let state = app.state::<Mutex<PopupState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if state
        .pending
        .as_ref()
        .is_some_and(|r| r.generation == generation)
    {
        state.presented = Some(generation);
    }
    Ok(())
}
#[tauri::command]
pub fn tray_menu_dismiss(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    authorize(&window)?;
    dismiss(&app, Some(generation))
}
#[tauri::command]
pub async fn tray_menu_action(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    action: String,
) -> Result<(), String> {
    authorize(&window)?;
    let pending = app
        .state::<Mutex<PopupState>>()
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .as_ref()
        .is_some_and(|r| r.generation == generation);
    if !pending {
        return Ok(());
    }
    let settings = app.state::<AppState>().current()?;
    if !items(&settings, capture_runtime::pin_count(&app))
        .iter()
        .any(|item| item.id == action && item.enabled && !item.separator)
    {
        return Err("此菜单项不可用".into());
    }
    dismiss(&app, Some(generation))?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = lifecycle::run_tray_action(&app, &action);
        if let Err(error) = &result {
            capture_runtime::report_capture_error(&app, error);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pins_follow_capture_and_reflect_persisted_visibility() {
        let mut settings = AppSettings::default();
        for (count, visible, enabled, checked) in [
            (0, true, false, false),
            (1, true, true, true),
            (2, false, true, false),
        ] {
            settings.capture.pins_visible = visible;
            let menu = items(&settings, count);
            let at = menu.iter().position(|i| i.id == "capture").unwrap();
            assert_eq!(menu[at + 1].id, "pins");
            assert_eq!(menu[at + 1].enabled, enabled);
            assert_eq!(menu[at + 1].checked, Some(checked));
        }
        settings.capture.enabled = false;
        assert!(items(&settings, 1)
            .iter()
            .any(|i| i.id == "pins" && i.enabled));
    }
    #[test]
    fn menu_keeps_existing_actions_and_localizes() {
        let mut settings = AppSettings {
            language: InterfaceLanguage::En,
            ..Default::default()
        };
        settings.alt_snap.enabled = false;
        let menu = items(&settings, 1);
        assert_eq!(
            menu.iter().find(|i| i.id == "pins").unwrap().label,
            "Show / Hide pins"
        );
        for id in [
            "translator",
            "vision",
            "screenshot",
            "optimizer",
            "capture",
            "altsnap",
            "settings",
            "restart_admin",
            "quit",
        ] {
            assert!(menu.iter().any(|i| i.id == id));
        }
        assert!(!menu.iter().find(|i| i.id == "altsnap").unwrap().enabled);
    }
    #[test]
    fn popup_stays_inside_monitor_and_flips_below_on_top_taskbars() {
        assert_eq!(
            popup_position(1900, 1040, 302, 434, 8, (0, 0, 1920, 1040)),
            (1618, 606)
        );
        assert_eq!(
            popup_position(-1900, 20, 302, 434, 8, (-1920, 0, 0, 1040)),
            (-1908, 12)
        );
        // A bottom-taskbar pointer must not leave a gap above the work area.
        assert_eq!(
            popup_position(1900, 1060, 302, 434, 8, (0, 0, 1920, 1080)),
            (1618, 634)
        );
    }
    #[test]
    fn visible_menu_edges_stay_near_pointer_at_each_dpi_and_size() {
        for dpi in [1.0_f64, 1.25, 1.5, 2.0] {
            for scale in [0.75_f64, 1.0, 1.5, 2.0] {
                let padding = (MENU_SHADOW * scale * dpi).round() as i32;
                let width = ((MENU_WIDTH + 2.0 * MENU_SHADOW) * scale * dpi).ceil() as i32;
                let height = (434.0 * scale * dpi).ceil() as i32;
                let (x, y) = popup_position(1600, 2000, width, height, padding, (0, 0, 3840, 2160));
                assert_eq!(x + padding, 1600);
                assert_eq!(y + height - padding, 2000);
            }
        }
    }
}
