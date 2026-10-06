//! Isolated debug-only audit: real WebView2 menu, retained pixels and settings.
//! No single-instance plugin, hotkey registration or user data directories.
use crate::application::{
    capture_native as native, capture_runtime as runtime, commands, lifecycle, state::AppState,
    tray_popup,
};
use crate::domain::settings::AppSettings;
use crate::infrastructure::{images::ImageStore, settings_store::SettingsStore};
use image::RgbaImage;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};

struct Audit(Mutex<Option<mpsc::Sender<Value>>>);
#[tauri::command]
fn tray_check_report(app: AppHandle, value: Value) {
    if let Some(sender) = app.state::<Audit>().0.lock().unwrap().take() {
        let _ = sender.send(value);
    }
}
fn until(check: impl Fn() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        if check() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("Native popup audit timed out".into())
}
fn all_pins(app: &AppHandle, visible: bool) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    let manager = app.state::<runtime::CaptureManager>();
    let pins = manager
        .sessions
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, s)| s.pin_record.is_some())
        .map(|(label, s)| (label.clone(), s.ready, s.pin_cover.clone()))
        .collect::<Vec<_>>();
    !pins.is_empty()
        && pins.iter().all(|(label, ready, cover)| {
            *ready
                && app
                    .get_webview_window(label)
                    .is_some_and(|w| w.is_visible().unwrap_or(!visible) == visible)
                && cover
                    .as_ref()
                    .and_then(|c| c.hwnd().ok())
                    .is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() == visible })
        })
}
fn inspect(app: &AppHandle, window: &WebviewWindow) -> Result<Value, String> {
    let (sender, receiver) = mpsc::channel();
    *app.state::<Audit>().0.lock().unwrap() = Some(sender);
    window.eval(r#"(() => {
      const menu = document.querySelector('[role="menu"]');
      const pins = document.querySelector('[role="menuitemcheckbox"]');
      const box = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      window.__TAURI_INTERNALS__.invoke('tray_check_report', {value: {
        scroll: menu.scrollHeight - menu.clientHeight, radius: style.borderRadius, clip: style.clipPath,
        left: box.left, bottom: box.bottom, focusedItems: menu.querySelectorAll('button:focus-visible').length,
        count: menu.querySelectorAll('button').length, disabled: pins.disabled,
        checked: pins.getAttribute('aria-checked') === 'true', checkIcon: !!pins.querySelector('svg'),
        inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
      }});
    })()"#).map_err(|e| e.to_string())?;
    let mut value = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Menu inspection timed out".to_string())?;
    let position = window.inner_position().map_err(|e| e.to_string())?;
    let dpi = window.scale_factor().map_err(|e| e.to_string())?;
    value["visibleLeft"] = json!(position.x as f64 + value["left"].as_f64().unwrap() * dpi);
    value["visibleBottom"] = json!(position.y as f64 + value["bottom"].as_f64().unwrap() * dpi);
    Ok(value)
}
fn inspect_taskbar_anchor(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<Option<Value>, String> {
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
            MonitorFromPoint(POINT { x: 650, y: 600 }, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
        .as_bool()
        {
            return Err("Could not inspect taskbar monitor".into());
        }
    }
    if monitor.rcWork.bottom >= monitor.rcMonitor.bottom {
        return Ok(None);
    }
    let x = (monitor.rcMonitor.left + monitor.rcMonitor.right) / 2;
    let y = (monitor.rcWork.bottom + monitor.rcMonitor.bottom) / 2;
    eprintln!("audit: opening taskbar menu at {x},{y}");
    tray_popup::open(app, x, y)?;
    until(|| window.is_visible().unwrap_or(false)).map_err(|error| {
        format!(
            "{error}; visible={:?}; focused={:?}; snapshot={}",
            window.is_visible(),
            window.is_focused(),
            serde_json::to_string(&tray_popup::tray_menu_snapshot(app.clone(), window.clone()))
                .unwrap()
        )
    })?;
    let mut value = inspect(app, window)?;
    if (value["visibleLeft"].as_f64().unwrap() - x as f64).abs() > 1.0
        || (value["visibleBottom"].as_f64().unwrap() - y as f64).abs() > 1.0
        || value["focusedItems"] != 0
    {
        return Err(format!("Taskbar menu anchor invalid: {value}"));
    }
    value["pointer"] = json!({"x": x, "y": y});
    value["workBottom"] = json!(monitor.rcWork.bottom);
    tray_popup::dismiss(app, None)?;
    Ok(Some(value))
}
pub fn run() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.task/tray-menu-native-profile");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.wainia.screenpilot.tray-menu-audit".into();
    tauri::Builder::default()
        .manage(Audit(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::capture_snapshot, commands::capture_ready, commands::capture_action,
            tray_popup::tray_menu_snapshot, tray_popup::tray_menu_ready, tray_popup::tray_menu_action, tray_popup::tray_menu_dismiss,
            tray_check_report,
        ])
        .on_window_event(lifecycle::handle_window_event)
        .setup(move |app| {
            let store = SettingsStore::new(&root);
            let mut settings = AppSettings::default();
            settings.alt_snap.enabled = false;
            settings.capture.pins_visible = false;
            store.save(&settings).map_err(std::io::Error::other)?;
            app.manage(runtime::CaptureManager::new(root.join("capture"), root.join("data")));
            app.manage(AppState::new(store, ImageStore::new(&root.join("data"), &root.join("cache")).map_err(std::io::Error::other)?, settings.clone(), root.join("webview"), root.join("cache")));
            lifecycle::create_tray(app.handle(), &settings).map_err(std::io::Error::other)?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<Value, String> {
                    let window = app.get_webview_window(tray_popup::LABEL).ok_or("Missing popup")?;
                    eprintln!("audit: opening empty menu");
                    tray_popup::open(&app, 650, 600)?;
                    until(|| window.is_visible().unwrap_or(false))?;
                    let empty = inspect(&app, &window)?;
                    eprintln!("audit: empty menu painted");
                    if empty["disabled"] != true || empty["checked"] != false || empty["inWindow"] != true { return Err(format!("Empty menu invalid: {empty}")); }
                    if empty["clip"] != "inset(-8px round 17px)"
                        || empty["focusedItems"] != 0
                        || (empty["visibleLeft"].as_f64().unwrap() - 650.0).abs() > 1.0
                        || (empty["visibleBottom"].as_f64().unwrap() - 600.0).abs() > 1.0
                    { return Err(format!("Menu shadow or pointer anchor invalid: {empty}")); }
                    tray_popup::dismiss(&app, None)?;
                    let taskbar = inspect_taskbar_anchor(&app, &window)?;
                    let bounds = native::Rect { x: 50, y: 50, width: 160, height: 100 };
                    let image = RgbaImage::from_fn(160, 100, |x, y| image::Rgba([(x % 255) as u8, (y % 255) as u8, 170, 255]));
                    let options: Vec<Value> = serde_json::from_str(include_str!("domain/capture-settings-schema.json")).unwrap();
                    let snapshot = runtime::Snapshot {
                        id: "tray-pin-audit".into(), mode: "pin".into(), bounds,
                        screens: vec![native::desktop_rect()?], image: native::data_url(&image)?,
                        options: options.iter().map(|f| (f["key"].as_str().unwrap().into(), f["default"].clone())).collect::<serde_json::Map<String, Value>>().into(),
                        tools: json!({}), windows: vec![], selection: None, marks: Value::Null, pin_state: None, scan_results: None, scan_error: None,
                    };
                    runtime::pin(&app, &snapshot, &image, bounds, None)?;
                    eprintln!("audit: loading hidden pin");
                    until(|| all_pins(&app, false))?;
                    let manager = app.state::<runtime::CaptureManager>();
                    let pin_id = manager.sessions.lock().unwrap().values().find_map(|s| s.pin_record.as_ref().map(|record| record.id)).ok_or("Missing audit pin")?;
                    // Wait for the editor's initial canonical marks/frame save.
                    // Visibility must be compared after initialization settles.
                    until(|| manager.pins.load().unwrap().0.iter().any(|(record, _)| record.id == pin_id && record.state.marks.is_array() && record.state.frame.is_some()))?;
                    let before = manager.pins.load()?.0;
                    tray_popup::open(&app, 650, 600)?;
                    until(|| window.is_visible().unwrap_or(false))?;
                    let hidden = inspect(&app, &window)?;
                    eprintln!("audit: clicking show pins");
                    if hidden["disabled"] != false || hidden["checked"] != false { return Err(format!("Hidden menu invalid: {hidden}")); }
                    window.eval("document.querySelector('[role=menuitemcheckbox]').click()") .map_err(|e| e.to_string())?;
                    until(|| app.state::<AppState>().current().unwrap().capture.pins_visible && all_pins(&app, true))?;
                    if window.is_visible().unwrap_or(true) { return Err("Popup stayed open after action".into()); }
                    tray_popup::open(&app, 650, 600)?;
                    until(|| window.is_visible().unwrap_or(false))?;
                    let shown = inspect(&app, &window)?;
                    if shown["checked"] != true || shown["checkIcon"] != true || shown["scroll"] != 0 || shown["radius"] != "9px" { return Err(format!("Shown menu invalid: {shown}")); }
                    window.eval("document.querySelector('[role=menuitemcheckbox]').click()") .map_err(|e| e.to_string())?;
                    until(|| !app.state::<AppState>().current().unwrap().capture.pins_visible && all_pins(&app, false))?;
                    if app.state::<AppState>().store.load()?.capture.pins_visible { return Err("Hidden preference did not persist".into()); }
                    let after = manager.pins.load()?.0;
                    if serde_json::to_value(before.iter().map(|(record, _)| record).collect::<Vec<_>>()).unwrap() != serde_json::to_value(after.iter().map(|(record, _)| record).collect::<Vec<_>>()).unwrap() { return Err("Visibility toggle changed settled pin records".into()); }
                    let labels = manager.sessions.lock().unwrap().keys().cloned().collect::<Vec<_>>();
                    for label in labels { runtime::close(&app, &label); }
                    // Exercise the same persisted-pin restoration used at startup.
                    runtime::warm_up(app.clone());
                    until(|| runtime::pin_count(&app) == after.len() && all_pins(&app, false))?;
                    let restored = runtime::pin_count(&app);
                    let labels = manager.sessions.lock().unwrap().keys().cloned().collect::<Vec<_>>();
                    for label in labels { runtime::close(&app, &label); }
                    tray_popup::open(&app, 650, 600)?;
                    until(|| window.is_visible().unwrap_or(false))?;
                    let closed = inspect(&app, &window)?;
                    if closed["disabled"] != true { return Err("Last pin closure did not disable the menu".into()); }
                    Ok(json!({"empty": empty, "taskbar": taskbar, "hidden": hidden, "shown": shown, "closed": closed, "settingsPersisted": true, "pinRecordsPreserved": true, "hiddenNativePixels": true, "restoredHiddenPins": restored}))
                })();
                println!("{}", serde_json::to_string(&result).unwrap());
                app.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .run(context).expect("Isolated tray popup audit could not start");
}
