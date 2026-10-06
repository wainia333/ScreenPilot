//! In-process Tauri host for capture interactions. There is no sidecar.
use super::{capture_native as native, state::AppState};
use gifrecorder::{
    frame_store::{FrameStore, RecordConfig},
    recorder::RecordSession,
};
use image::RgbaImage;
use native::Rect;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub mode: String,
    pub bounds: Rect,
    pub screens: Vec<Rect>,
    pub image: String,
    pub options: Value,
    pub tools: Value,
    pub windows: Vec<crate::vision::WindowInfo>,
    pub selection: Option<Rect>,
    pub marks: Value,
    pub pin_state: Option<super::capture_pins::State>,
    pub scan_results: Option<Vec<Value>>,
    pub scan_error: Option<String>,
}
pub struct Session {
    pub snapshot: Snapshot,
    pub recorder: Option<RecordSession>,
    pub frames: Option<Arc<FrameStore>>,
    pub scroll: Option<RgbaImage>,
    pub region: Option<Rect>,
    pub interaction: Option<Vec<Rect>>,
    pub dialog_open: bool,
    pub created: Instant,
    pub ready: bool,
    pub cursor: super::capture_cursor::Track,
    pub scroll_count: usize,
    pub horizontal: bool,
    pub scroll_trigger: super::capture_scroll::Trigger,
    pub scroll_gate: Arc<Mutex<()>>,
    pub scroll_engine: String,
    pub scroll_live: bool,
    pub pin_record: Option<super::capture_pins::Record>,
    pub pin_handoff: Option<PinHandoff>,
    pub pin_cover: Option<Arc<super::capture_pin_handoff::SelectionCover>>,
}
#[derive(Clone)]
pub struct PinHandoff {
    source_id: String,
    complete: std::sync::mpsc::Sender<Result<(), String>>,
}
pub struct CaptureManager {
    pub directory: PathBuf,
    pub pins: super::capture_pins::Store,
    pin_moves: Mutex<HashMap<String, Instant>>,
    pub sessions: Mutex<HashMap<String, Session>>,
    handoff_gate: Mutex<()>,
    hidden: Mutex<Vec<String>>,
    busy: AtomicBool,
    stopping: AtomicBool,
    pub exporting: AtomicBool,
    pub export_cancelled: Arc<AtomicBool>,
}
impl CaptureManager {
    pub fn new(directory: PathBuf, data_directory: PathBuf) -> Self {
        Self {
            pins: super::capture_pins::Store::new(
                &data_directory,
                directory.parent().unwrap_or(&directory),
            ),
            pin_moves: Mutex::new(HashMap::new()),
            directory,
            sessions: Mutex::new(HashMap::new()),
            handoff_gate: Mutex::new(()),
            hidden: Mutex::new(Vec::new()),
            busy: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            exporting: AtomicBool::new(false),
            export_cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}
pub fn busy(app: &AppHandle) -> bool {
    app.try_state::<CaptureManager>()
        .is_some_and(|m| m.busy.load(Ordering::Acquire))
}
pub fn pin_count(app: &AppHandle) -> usize {
    app.try_state::<CaptureManager>()
        .and_then(|manager| {
            manager
                .sessions
                .lock()
                .ok()
                .map(|sessions| sessions.values().filter(|s| s.pin_record.is_some()).count())
        })
        .unwrap_or(0)
}
pub fn synchronize_pin_visibility(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let state = app.state::<AppState>();
            // Wait for the settings transaction (including any rollback), then
            // read the latest preference rather than applying a stale snapshot.
            let visible = {
                let _write = state.lock_settings_write()?;
                state.current()?.capture.pins_visible
            };
            // Never wait for the UI thread while holding the settings write
            // lock: synchronous settings commands also run on that thread.
            let manager = app.state::<CaptureManager>();
            let _gate = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
            let pins = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .iter()
                .filter(|(_, s)| s.ready && s.pin_record.is_some() && s.pin_handoff.is_none())
                .filter_map(|(label, s)| s.pin_cover.clone().map(|cover| (label.clone(), cover)))
                .collect::<Vec<_>>();
            for (label, cover) in pins {
                if let Some(window) = app.get_webview_window(&label) {
                    cover.set_visibility(&window, visible)?;
                }
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            report_capture_error(&app, &format!("钉图显示状态更新失败：{error}"));
        }
    });
}
pub fn focus(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("capture") {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn option(snapshot: &Snapshot, key: &str) -> Value {
    snapshot.options.get(key).cloned().unwrap_or(Value::Null)
}
fn options(app: &AppHandle) -> Result<Value, String> {
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("../domain/capture-settings-schema.json"))
            .map_err(|e| e.to_string())?;
    let mut options = serde_json::Map::new();
    for field in schema {
        if let Some(key) = field["key"].as_str() {
            options.insert(key.into(), field["default"].clone());
        }
    }
    options.extend(app.state::<AppState>().current()?.capture.native_options);
    Ok(Value::Object(options))
}
fn build_window(app: &AppHandle, label: &str, bounds: Rect) -> Result<(), String> {
    if app.get_webview_window(label).is_none() {
        WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(format!("index.html?route=capture&window={label}").into()),
        )
        .title("ScreenPilot 截图")
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .content_protected(label == "capture")
        .data_directory(app.state::<AppState>().webview_data_directory.clone())
        .build()
        .map_err(|e| e.to_string())?;
    }
    let window = app.get_webview_window(label).ok_or("截图窗口创建失败")?;
    native::clear_hit_regions(&window)?;
    if label.starts_with("capture-pin-") {
        native::prepare_pin_host(&window)?;
        // The bound bitmap follows WM_WINDOWPOSCHANGED synchronously. A later
        // Tauri event callback can lag the OS drag loop and cause visible jitter.
    }
    window
        .set_content_protected(label == "capture")
        .map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    super::lifecycle::disable_capture_window_transitions(
        window.hwnd().map_err(|e| e.to_string())?,
    )?;
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    let _ = window.set_ignore_cursor_events(false);
    Ok(())
}
fn hide_host(app: &AppHandle) -> Result<(), String> {
    app.state::<AppState>().begin_surface_action();
    let manager = app.state::<CaptureManager>();
    let mut hidden = manager.hidden.lock().map_err(|e| e.to_string())?;
    for label in ["main", "translator", "vision", "ocr"] {
        if let Some(window) = app
            .get_webview_window(label)
            .filter(|w| w.is_visible().unwrap_or(false))
        {
            hidden.push(label.into());
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    unsafe {
        let _ = windows::Win32::Graphics::Dwm::DwmFlush();
    }
    Ok(())
}
fn restore(app: &AppHandle) {
    let manager = app.state::<CaptureManager>();
    if let Ok(mut hidden) = manager.hidden.lock() {
        for label in hidden.drain(..) {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.show();
            }
        }
    };
    manager.busy.store(false, Ordering::Release);
}
pub fn request(app: &AppHandle, mode: &str) -> Result<(), String> {
    if !matches!(mode, "image" | "record" | "scan") {
        return Err("未知截图模式".into());
    }
    if !app.state::<AppState>().current()?.capture.enabled {
        return Err("请先启用截图并保存设置".into());
    }
    if crate::native_freeze::is_active() {
        return Err("请先完成当前 Vision/OCR 选区".into());
    }
    if app
        .state::<CaptureManager>()
        .busy
        .swap(true, Ordering::AcqRel)
    {
        return focus(app);
    }
    let result = (|| {
        hide_host(app)?;
        start_session(app, mode, None, None)
    })();
    if result.is_err() {
        close(app, "capture");
    }
    result
}
pub(crate) fn start_session(
    app: &AppHandle,
    mode: &str,
    selection: Option<Rect>,
    prefetched: Option<RgbaImage>,
) -> Result<(), String> {
    let bounds = native::desktop_rect()?;
    let mut options = options(app)?;
    if !options["screenshot_border_persist"]
        .as_bool()
        .unwrap_or(false)
    {
        options["screenshot_border_enabled"] = json!(false);
    }
    let mut image = prefetched.map(Ok).unwrap_or_else(|| {
        native::capture(bounds, options["capture_engine"].as_str().unwrap_or("auto"))
    })?;
    if options["capture_include_cursor"].as_bool().unwrap_or(false) {
        super::capture_platform::include_cursor(&mut image, bounds)?;
    }
    let screens = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    let manager = app.state::<CaptureManager>();
    let tools = serde_json::to_value(app.state::<AppState>().current()?.capture.tools)
        .map_err(|e| e.to_string())?;
    let snapshot = Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        mode: mode.into(),
        bounds,
        screens,
        image: native::data_url(&image)?,
        options,
        tools,
        windows: crate::vision::list_windows(Some(crate::vision::ScreenSpace {
            scale: 1.0,
            left: bounds.x,
            top: bounds.y,
            right: bounds.x + bounds.width as i32,
            bottom: bounds.y + bounds.height as i32,
        })),
        selection,
        marks: Value::Null,
        pin_state: None,
        scan_results: None,
        scan_error: None,
    };
    manager.sessions.lock().map_err(|e| e.to_string())?.insert(
        "capture".into(),
        Session {
            snapshot,
            recorder: None,
            frames: None,
            scroll: None,
            region: None,
            interaction: None,
            dialog_open: false,
            created: Instant::now(),
            ready: false,
            cursor: Default::default(),
            scroll_count: 0,
            horizontal: false,
            scroll_trigger: Default::default(),
            scroll_gate: Arc::new(Mutex::new(())),
            scroll_engine: String::new(),
            scroll_live: false,
            pin_record: None,
            pin_handoff: None,
            pin_cover: None,
        },
    );
    build_window(app, "capture", bounds)?;
    app.emit_to("capture", "capture:session", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn snapshot(app: &AppHandle, label: &str) -> Result<Snapshot, String> {
    app.state::<CaptureManager>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .map(|s| s.snapshot.clone())
        .ok_or_else(|| "没有活动截图".into())
}
pub fn ready(app: &AppHandle, label: &str, id: &str) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    // Serialize show/withdraw with Escape and load failure. Window operations
    // never run under the session mutex, and commands run off the UI thread.
    let _guard = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
    let handoff = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(label)
            .filter(|session| session.snapshot.id == id)
            .ok_or("截图会话已结束")?;
        session.pin_handoff.clone()
    };
    if let Some(handoff) = &handoff {
        check(app, "capture", &handoff.source_id)?;
    }
    let window = app.get_webview_window(label).ok_or("截图窗口已关闭")?;
    if label.starts_with("capture-pin-") {
        if handoff.is_some() {
            let source = app.get_webview_window("capture").ok_or("截图窗口已关闭")?;
            let cover = {
                let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                sessions
                    .get("capture")
                    .and_then(|s| s.pin_cover.clone())
                    .or_else(|| sessions.get(label).and_then(|s| s.pin_cover.clone()))
            };
            return native::prepare_pin_visibility(
                &window,
                &source,
                cover.as_ref().map(|c| c.hwnd()).transpose()?,
            );
        }
        let surface = manager
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(label)
            .and_then(|s| s.pin_cover.clone())
            .ok_or("钉图像素尚未准备")?;
        if !app.state::<AppState>().current()?.capture.pins_visible {
            return Ok(());
        }
        surface.resume()?;
        return native::prepare_pin_visibility(&window, &window, Some(surface.hwnd()?));
    }
    let result = window
        .show()
        .and_then(|()| window.set_focus())
        .map_err(|e| e.to_string());
    if result.is_ok() {
        if let Some(session) = manager
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(label)
            .filter(|s| s.snapshot.id == id)
        {
            session.ready = true;
        }
    }
    result
}
fn present_pin(
    app: &AppHandle,
    label: &str,
    id: &str,
    area: Option<Rect>,
    opacity: f64,
) -> Result<(), String> {
    if !label.starts_with("capture-pin-") {
        return Err("此操作仅适用于钉图".into());
    }
    let manager = app.state::<CaptureManager>();
    let handoff = manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .filter(|s| s.snapshot.id == id)
        .ok_or("钉图已关闭")?
        .pin_handoff
        .clone();
    if let Some(handoff) = &handoff {
        check(app, "capture", &handoff.source_id)?;
    }
    let window = app.get_webview_window(label).ok_or("钉图窗口已关闭")?;
    let area = area.ok_or("缺少钉图绘制区域")?.validate()?;
    if !opacity.is_finite() || !(0.1..=1.0).contains(&opacity) {
        return Err("钉图透明度无效".into());
    }
    let _guard = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
    check(app, label, id)?;
    if let Some(handoff) = &handoff {
        check(app, "capture", &handoff.source_id)?;
    }
    let cover = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let retained = if handoff.is_some() {
            sessions.get("capture").and_then(|s| s.pin_cover.clone())
        } else {
            None
        };
        retained
            .or_else(|| sessions.get(label).and_then(|s| s.pin_cover.clone()))
            .ok_or("钉图像素已关闭")?
    };
    // Bind the same HWND; there is no visual replacement after readiness.
    cover.bind(&window, area)?;
    {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(label)
            .filter(|s| s.snapshot.id == id)
            .ok_or("钉图已关闭")?;
        session.ready = true;
        session.pin_handoff = None;
        session.pin_cover = Some(cover.clone());
    }
    if let Some(handoff) = handoff {
        if let Some(source) = manager
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut("capture")
        {
            source.pin_cover = None;
        }
        close_session_locked(app, "capture", Some(&handoff.source_id));
        let _ = handoff.complete.send(Ok(()));
    }
    if app.state::<AppState>().current()?.capture.pins_visible {
        let _ = window.set_focus();
    } else {
        cover.set_visibility(&window, false)?;
    }
    super::tray_popup::refresh(app)?;
    Ok(())
}
pub fn check(app: &AppHandle, label: &str, id: &str) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if sessions
        .get(label)
        .is_none_or(|session| session.snapshot.id != id)
    {
        return Err("截图会话已结束".into());
    }
    Ok(())
}
pub fn close(app: &AppHandle, label: &str) {
    close_session(app, label, None);
}
pub(crate) fn withdraw(app: &AppHandle, label: &str) {
    if label.starts_with("capture-pin-") {
        if let Some(surface) = app
            .state::<CaptureManager>()
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(label).and_then(|s| s.pin_cover.clone()))
        {
            surface.hide();
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        if label.starts_with("capture-pin-") && native::set_pin_visibility(&window, false).is_ok() {
            return;
        }
        super::lifecycle::force_hide_window(&window);
        let _ = window.hide();
    }
}

pub(crate) fn report_capture_error(app: &AppHandle, message: &str) {
    let target = ["main", "translator", "vision", "ocr"]
        .into_iter()
        .filter_map(|label| app.get_webview_window(label))
        .find(|window| window.is_visible().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = target {
        let _ = window.show();
        let _ = window.emit(
            "screenpilot:notice",
            json!({"message": message, "tone": "error"}),
        );
    }
}
fn close_session(app: &AppHandle, label: &str, expected_id: Option<&str>) {
    let manager = app.state::<CaptureManager>();
    let Ok(_guard) = manager.handoff_gate.lock() else {
        return;
    };
    close_session_locked(app, label, expected_id);
}
fn close_session_locked(app: &AppHandle, label: &str, expected_id: Option<&str>) {
    // Release the session lock before window destruction or waiting for the recorder.
    let manager = app.state::<CaptureManager>();
    let mut session = {
        let Ok(mut sessions) = manager.sessions.lock() else {
            return;
        };
        if expected_id.is_some_and(|id| {
            sessions
                .get(label)
                .is_none_or(|session| session.snapshot.id != id)
        }) {
            return;
        }
        sessions.remove(label)
    };
    if label == "capture" {
        // Owned bitmaps must be released before a pending destination is
        // destroyed, otherwise Windows destroys them behind the Arc's back.
        if let Some(cover) = session.as_mut().and_then(|s| s.pin_cover.take()) {
            cover.close();
        }
        // Abandon any replacement still loading when the source is cancelled.
        if let Some(source) = &session {
            let pending = manager
                .sessions
                .lock()
                .map(|sessions| {
                    sessions
                        .iter()
                        .filter(|(_, s)| {
                            s.pin_handoff
                                .as_ref()
                                .is_some_and(|h| h.source_id == source.snapshot.id)
                        })
                        .map(|(label, s)| (label.clone(), s.snapshot.id.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (pin_label, pin_id) in pending {
                close_session_locked(app, &pin_label, Some(&pin_id));
            }
        }
        app.state::<CaptureManager>()
            .export_cancelled
            .store(true, Ordering::Release);
    }
    if let Some(window) = app.get_webview_window(label) {
        withdraw(app, label);
        if label != "capture" {
            let _ = window.destroy();
        }
    }
    if let Some(mut session) = session {
        if let Some(cover) = session.pin_cover.take() {
            cover.close();
        }
        if let Some(handoff) = session.pin_handoff.take() {
            if let Some(record) = &session.pin_record {
                let _ = manager.pins.remove(record.id);
            }
            let _ = handoff.complete.send(Err("钉图交接未完成，请重试".into()));
        }
        if let Some(mut recorder) = session.recorder.take() {
            recorder.stop();
        }
    }
    if label == "capture" {
        restore(app);
    }
    if label.starts_with("capture-pin-") {
        let _ = super::tray_popup::refresh(app);
    }
}
pub fn pin(
    app: &AppHandle,
    source: &Snapshot,
    image: &RgbaImage,
    region: Rect,
    source_id: Option<&str>,
) -> Result<(), String> {
    let screen = source
        .screens
        .iter()
        .find(|s| {
            region.x >= s.x
                && region.y >= s.y
                && i64::from(region.x) < i64::from(s.x) + i64::from(s.width)
                && i64::from(region.y) < i64::from(s.y) + i64::from(s.height)
        })
        .copied()
        .unwrap_or(native::desktop_rect()?);
    let mut record = super::capture_pins::Record::new(
        Rect {
            width: image.width(),
            height: image.height(),
            ..region
        },
        screen,
        source.marks.clone(),
        option(source, "pin_default_opacity")
            .as_f64()
            .unwrap_or(1.0),
        option(source, "pin_auto_toolbar")
            .as_bool()
            .unwrap_or(false),
    );
    if source_id.is_some() {
        record.state.opacity = 1.0;
        record.state.frame = app
            .state::<CaptureManager>()
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get("capture")
            .and_then(|session| session.pin_cover.as_ref())
            .and_then(|cover| cover.frame.clone());
        if record.state.frame.is_some() {
            // A selection spanning monitors must retain its physical size too.
            record.state.view.zoom = 1.0;
        }
    }
    app.state::<CaptureManager>().pins.create(&record, image)?;
    let (complete, receiver) = std::sync::mpsc::channel();
    let handoff = source_id.map(|id| PinHandoff {
        source_id: id.into(),
        complete,
    });
    let label = format!("capture-pin-{}", record.id);
    let result = open_pin(app, source, image, record.clone(), handoff).and_then(|()| {
        if source_id.is_some() {
            receiver
                .recv_timeout(Duration::from_secs(20))
                .map_err(|_| "钉图加载超时，请重试".to_string())?
        } else {
            Ok(())
        }
    });
    if result.is_err() {
        let manager = app.state::<CaptureManager>();
        let _guard = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
        // A ready notification at the timeout boundary still wins the handoff.
        if manager
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&label)
            .is_some_and(|s| s.ready)
        {
            return Ok(());
        }
        close_session_locked(app, &label, None);
        let _ = app.state::<CaptureManager>().pins.remove(record.id);
    }
    result
}
fn open_pin(
    app: &AppHandle,
    source: &Snapshot,
    image: &RgbaImage,
    mut record: super::capture_pins::Record,
    handoff: Option<PinHandoff>,
) -> Result<(), String> {
    let label = format!("capture-pin-{}", record.id);
    let manager = app.state::<CaptureManager>();
    let _guard = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
    if let Some(handoff) = &handoff {
        check(app, "capture", &handoff.source_id)?;
    }
    record.state.offset = super::capture_pins::Offset { x: 12.0, y: 12.0 };
    let bounds = record.window_bounds();
    let snapshot = Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        mode: "pin".into(),
        image: native::data_url(image)?,
        bounds: record.bounds,
        selection: None,
        windows: Vec::new(),
        marks: record.state.marks.clone(),
        pin_state: Some(record.state.clone()),
        ..source.clone()
    };
    app.state::<CaptureManager>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            label.clone(),
            Session {
                snapshot,
                recorder: None,
                frames: None,
                scroll: None,
                region: None,
                interaction: None,
                dialog_open: false,
                created: Instant::now(),
                ready: false,
                cursor: Default::default(),
                scroll_count: 0,
                horizontal: false,
                scroll_trigger: Default::default(),
                scroll_gate: Arc::new(Mutex::new(())),
                scroll_engine: String::new(),
                scroll_live: false,
                pin_record: Some(record),
                pin_handoff: handoff,
                pin_cover: None,
            },
        );
    let result = build_window(app, &label, bounds);
    if result.is_err() {
        close_session_locked(app, &label, None);
    }
    result
}
fn open_scan(app: &AppHandle, source: &Snapshot, selection: Rect) -> Result<String, String> {
    let center = (
        selection.x + selection.width as i32 / 2,
        selection.y + selection.height as i32 / 2,
    );
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| {
            center.0 >= m.position().x
                && center.1 >= m.position().y
                && center.0 < m.position().x + m.size().width as i32
                && center.1 < m.position().y + m.size().height as i32
        })
        .or(monitors.first())
        .ok_or("未找到屏幕")?;
    let screen = Rect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    };
    let bounds = super::capture_scan::popup_bounds(selection, screen, monitor.scale_factor());
    let label = format!("capture-scan-{}", uuid::Uuid::new_v4());
    let snapshot = Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        mode: "scan-result".into(),
        image: String::new(),
        bounds,
        selection: Some(selection),
        marks: Value::Null,
        pin_state: None,
        scan_results: None,
        scan_error: None,
        ..source.clone()
    };
    app.state::<CaptureManager>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            label.clone(),
            Session {
                snapshot,
                recorder: None,
                frames: None,
                scroll: None,
                region: None,
                interaction: None,
                dialog_open: false,
                created: Instant::now(),
                ready: false,
                cursor: Default::default(),
                scroll_count: 0,
                horizontal: false,
                scroll_trigger: Default::default(),
                scroll_gate: Arc::new(Mutex::new(())),
                scroll_engine: String::new(),
                scroll_live: false,
                pin_record: None,
                pin_handoff: None,
                pin_cover: None,
            },
        );
    let result = (|| {
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?window={label}").into()),
        )
        .title("扫码结果 · ScreenPilot")
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .focused(false)
        .inner_size(560.0, 360.0)
        .data_directory(app.state::<AppState>().webview_data_directory.clone())
        .build()
        .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(PhysicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        // The existing React jelly animation owns arrival, with no second DWM fade.
        super::lifecycle::disable_capture_window_transitions(
            window.hwnd().map_err(|e| e.to_string())?,
        )?;
        Ok(label.clone())
    })();
    if result.is_err() {
        close(app, &label);
    }
    result
}
pub fn pin_moved(app: &AppHandle, label: &str) {
    if let Some(manager) = app.try_state::<CaptureManager>() {
        if let Ok(mut moves) = manager.pin_moves.lock() {
            moves.insert(label.into(), Instant::now());
        }
    }
}
pub fn forget_pin(app: &AppHandle, label: &str, id: Option<&str>) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions
        .get_mut(label)
        .filter(|s| id.is_none_or(|id| s.snapshot.id == id))
    {
        if let Some(record) = &session.pin_record {
            manager.pins.remove(record.id)?;
        }
        // Prevent an already queued move/property save from recreating a closed pin.
        session.pin_record = None;
    }
    Ok(())
}
fn persist_pin(
    app: &AppHandle,
    label: &str,
    state: Option<(&str, super::capture_pins::State)>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let manager = app.state::<CaptureManager>();
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get_mut(label) else {
        return Ok(());
    };
    if state
        .as_ref()
        .is_some_and(|(id, _)| session.snapshot.id != *id)
    {
        return Err("钉图会话已结束".into());
    }
    let Some(record) = session.pin_record.as_mut() else {
        return Ok(());
    };
    let mut next = record.clone();
    if let Some((_, state)) = state {
        state.validate(next.bounds)?;
        next.state = state;
    }
    next.bounds.x = origin.x.saturating_add(next.state.offset.x.round() as i32);
    next.bounds.y = origin.y.saturating_add(next.state.offset.y.round() as i32);
    manager.pins.save(&next)?;
    session.snapshot.pin_state = Some(next.state.clone());
    session.snapshot.marks = next.state.marks.clone();
    *record = next;
    Ok(())
}
fn restore_pins(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    let (pins, mut failures) = manager.pins.load()?;
    let screens = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect::<Vec<_>>();
    let source = Snapshot {
        id: String::new(),
        mode: "pin".into(),
        bounds: native::desktop_rect()?,
        screens: screens.clone(),
        image: String::new(),
        options: options(app)?,
        tools: serde_json::to_value(app.state::<AppState>().current()?.capture.tools)
            .map_err(|e| e.to_string())?,
        windows: Vec::new(),
        selection: None,
        marks: Value::Null,
        pin_state: None,
        scan_results: None,
        scan_error: None,
    };
    for (mut record, image) in pins {
        if manager.stopping.load(Ordering::Acquire) {
            break;
        }
        record.keep_visible(&screens);
        if open_pin(app, &source, &image, record, None).is_err() {
            failures += 1;
        }
    }
    if failures != 0 {
        return Err(format!(
            "{failures} 张钉图未能恢复，请检查钉图数据目录。\n{}",
            manager.pins.directory.display()
        ));
    }
    Ok(())
}
pub fn save_image(
    app: &AppHandle,
    snapshot: &Snapshot,
    image: &RgbaImage,
    dialog: bool,
) -> Result<Option<PathBuf>, String> {
    let format = option(snapshot, "screenshot_format")
        .as_str()
        .unwrap_or("PNG")
        .to_ascii_lowercase();
    let name = crate::domain::capture_filename::render(
        option(snapshot, "screenshot_filename")
            .as_str()
            .unwrap_or(crate::domain::capture_filename::DEFAULT),
        &format,
        chrono::Local::now(),
    )?;
    let folder = option(snapshot, "screenshot_save_path");
    let folder = folder
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .picture_dir()
                .map_err(|e| e.to_string())?
                .join("ScreenPilot"),
        );
    let path = if dialog {
        let selected = app
            .dialog()
            .file()
            .set_title("保存截图")
            .set_file_name(name)
            .set_directory(&folder)
            .add_filter("图片", &["png", "jpg", "bmp", "webp", "pdf"])
            .blocking_save_file();
        match selected {
            Some(file) => file.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        }
    } else {
        reserve_capture_path(&folder, &name)?
    };
    let result = native::save(
        image,
        &path,
        option(snapshot, "screenshot_quality")
            .as_u64()
            .unwrap_or(100) as u8,
    );
    if let Err(error) = result {
        if !dialog {
            let _ = std::fs::remove_file(&path);
        }
        return Err(error);
    }
    Ok(Some(path))
}
fn reserve_capture_path(folder: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let (stem, extension) = name.rsplit_once('.').ok_or("文件名缺少扩展名")?;
    for index in 0..10000 {
        let path = folder.join(if index == 0 {
            name.to_owned()
        } else {
            format!("{stem}_{index}.{extension}")
        });
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("同名截图过多，请修改文件名格式".into())
}

#[cfg(test)]
mod filename_tests {
    #[test]
    fn capture_filename_reservation_never_overwrites_an_existing_image() {
        let folder = tempfile::tempdir().unwrap();
        let first = super::reserve_capture_path(folder.path(), "截图_2026-10-04.png").unwrap();
        std::fs::write(&first, b"original pixels").unwrap();
        let second = super::reserve_capture_path(folder.path(), "截图_2026-10-04.png").unwrap();
        assert_eq!(second.file_name().unwrap(), "截图_2026-10-04_1.png");
        assert_eq!(std::fs::read(first).unwrap(), b"original pixels");
    }
}
fn copy_result(
    app: &AppHandle,
    snapshot: &Snapshot,
    image: &RgbaImage,
    path: Option<&std::path::Path>,
) -> Result<(), String> {
    let reference = option(snapshot, "clipboard_file_reference_enabled")
        .as_bool()
        .unwrap_or(true);
    let mut temporary = None;
    if reference && path.is_none() {
        let directory = app
            .state::<CaptureManager>()
            .directory
            .join("clipboard-image");
        let destination = directory.join(format!("{}.png", uuid::Uuid::new_v4()));
        native::save(image, &destination, 100)?;
        temporary = Some(destination);
        // Bounded cache for CF_HDROP lifetime, never a clipboard history service.
        let mut files: Vec<_> = std::fs::read_dir(&directory)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "png"))
            .collect();
        files.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
        let excess = files.len().saturating_sub(20);
        for file in files.into_iter().take(excess) {
            let _ = std::fs::remove_file(file.path());
        }
    }
    native::copy_image(image)?;
    if reference {
        if let Some(path) = path.or(temporary.as_deref()) {
            super::capture_platform::append_file_reference(path)?;
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action: String,
    pub id: String,
    pub image: Option<String>,
    pub pin_image: Option<String>,
    pub rect: Option<Rect>,
    pub value: Option<Value>,
    pub preferences: Option<Preferences>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub options: Value,
    pub tools: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinViewUpdate {
    width: u32,
    height: u32,
    dx: i32,
    dy: i32,
    regions: Vec<Rect>,
    visual: super::capture_pin_render::Visual,
}
fn save_preferences(app: &AppHandle, preferences: Option<Preferences>) -> Result<(), String> {
    if let Some(preferences) = preferences {
        super::commands::save_capture_configuration(
            app,
            preferences.options,
            Some(preferences.tools),
        )?;
    }
    Ok(())
}
pub fn action(app: &AppHandle, label: &str, request: Action) -> Result<Value, String> {
    let manager = app.state::<CaptureManager>();
    // Do not copy the full desktop PNG for pointer hit testing or recorder polling.
    let mut snapshot = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let source = &sessions
            .get(label)
            .filter(|session| session.snapshot.id == request.id)
            .ok_or("截图会话已结束")?
            .snapshot;
        Snapshot {
            id: source.id.clone(),
            mode: source.mode.clone(),
            bounds: source.bounds,
            screens: source.screens.clone(),
            image: String::new(),
            options: source.options.clone(),
            tools: source.tools.clone(),
            windows: Vec::new(),
            selection: source.selection,
            marks: Value::Null,
            pin_state: source.pin_state.clone(),
            scan_results: source.scan_results.clone(),
            scan_error: source.scan_error.clone(),
        }
    };
    match request.action.as_str() {
        "pin_view" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let update: PinViewUpdate =
                serde_json::from_value(request.value.ok_or("缺少钉图视图")?)
                    .map_err(|e| e.to_string())?;
            let area = request.rect.ok_or("缺少钉图区域")?.validate()?;
            Rect {
                x: 0,
                y: 0,
                width: update.width,
                height: update.height,
            }
            .validate()?;
            if update.dx.unsigned_abs() > 32768
                || update.dy.unsigned_abs() > 32768
                || update.regions.len() > 64
            {
                return Err("钉图布局无效".into());
            }
            let window = app.get_webview_window(label).ok_or("钉图已关闭")?;
            let surface = {
                let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                let session = sessions
                    .get(label)
                    .filter(|s| s.snapshot.id == request.id && s.ready)
                    .ok_or("钉图尚未准备好")?;
                let record = session.pin_record.as_ref().ok_or("钉图已关闭")?;
                update.visual.state.validate(record.bounds)?;
                session.pin_cover.clone().ok_or("钉图画面已关闭")?
            };
            let source = request.image.as_deref().map(native::decode).transpose()?;
            let pixels = surface.render_view(source, &update.visual)?;
            surface.commit_view(
                &window,
                Rect {
                    x: update.dx,
                    y: update.dy,
                    width: update.width,
                    height: update.height,
                },
                area,
                update.regions,
                pixels,
            )?;
            {
                let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                let session = sessions
                    .get_mut(label)
                    .filter(|s| s.snapshot.id == request.id)
                    .ok_or("钉图已关闭")?;
                if let Some(record) = session.pin_record.as_mut() {
                    record.state = update.visual.state.clone();
                }
                session.snapshot.pin_state = Some(update.visual.state);
            }
            // Persist after the gesture settles, not on the interactive frame.
            pin_moved(app, label);
            Ok(Value::Null)
        }
        "pin_pixels" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let area = request.rect.ok_or("缺少钉图像素区域")?.validate()?;
            let packet = request.image.as_deref().ok_or("缺少钉图像素")?;
            let pixels = native::decode(packet)?;
            if pixels.dimensions() != (area.width, area.height) {
                return Err("钉图像素尺寸不一致".into());
            }
            let (surface, pending) = {
                let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                let session = sessions.get(label).ok_or("钉图已关闭")?;
                (
                    session.pin_cover.clone(),
                    session.pin_handoff.is_some()
                        && sessions
                            .get("capture")
                            .is_some_and(|s| s.pin_cover.is_some()),
                )
            };
            // During loading, keep the original selected pixels byte-for-byte.
            // Subsequent deliberate edits update this same native surface.
            if pending {
                let retained = manager
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get("capture")
                    .and_then(|s| s.pin_cover.clone())
                    .ok_or("钉图像素已关闭")?;
                retained.remember_packet(packet)?;
            } else {
                let window = app.get_webview_window(label).ok_or("钉图已关闭")?;
                if let Some(surface) = surface {
                    if surface.matches_packet(packet)? {
                        // Toolbar/menu geometry must not replace the retained
                        // desktop raster with the offscreen canvas raster.
                        surface.bind(&window, area)?;
                    } else {
                        surface.update(&window, area, pixels)?;
                        surface.remember_packet(packet)?;
                    }
                } else {
                    let origin = window.outer_position().map_err(|e| e.to_string())?;
                    let surface = super::capture_pin_handoff::SelectionCover::show_with_visibility(
                        app,
                        Rect {
                            x: origin.x + area.x,
                            y: origin.y + area.y,
                            ..area
                        },
                        pixels,
                        app.state::<AppState>().current()?.capture.pins_visible,
                    )?;
                    surface.remember_packet(packet)?;
                    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                    let session = sessions
                        .get_mut(label)
                        .filter(|s| s.snapshot.id == request.id)
                        .ok_or("钉图已关闭")?;
                    session.pin_cover = Some(surface);
                }
            }
            if let Some(value) = request.value {
                let state = serde_json::from_value::<super::capture_pins::State>(value)
                    .map_err(|e| e.to_string())?;
                // The final editable state travels with its displayed pixels.
                // Saving settings in another queue cannot discard this edit.
                persist_pin(app, label, Some((&request.id, state)))?;
            }
            Ok(Value::Null)
        }
        "pin_presented" => {
            let result = present_pin(
                app,
                label,
                &request.id,
                request.rect,
                request
                    .value
                    .as_ref()
                    .and_then(|v| v["opacity"].as_f64())
                    .unwrap_or(1.0),
            );
            if result.is_err() {
                let pending = manager
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(label)
                    .is_some_and(|s| s.snapshot.id == request.id && s.pin_handoff.is_some());
                if pending {
                    close_session(app, label, Some(&request.id));
                }
            }
            result?;
            Ok(Value::Null)
        }
        "pin_prepare" | "pin_abort" => {
            if label != "capture" {
                return Err("仅截图窗口可交接选区".into());
            }
            let gate = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .ok_or("截图已关闭")?
                .scroll_gate
                .clone();
            let _guard = gate.lock().map_err(|e| e.to_string())?;
            let _handoff_guard = manager.handoff_gate.lock().map_err(|e| e.to_string())?;
            check(app, label, &request.id)?;
            let window = app.get_webview_window(label).ok_or("截图窗口已关闭")?;
            let cover = if request.action == "pin_prepare" {
                let r = request.rect.ok_or("缺少钉图选区")?.validate()?;
                if r.x < snapshot.bounds.x
                    || r.y < snapshot.bounds.y
                    || i64::from(r.x) + i64::from(r.width)
                        > i64::from(snapshot.bounds.x) + i64::from(snapshot.bounds.width)
                    || i64::from(r.y) + i64::from(r.height)
                        > i64::from(snapshot.bounds.y) + i64::from(snapshot.bounds.height)
                {
                    return Err("钉图选区超出截图边界".into());
                }
                // The cover guards composition changes while the original
                // selected WebView pixels stay present underneath it.
                let frame = request
                    .value
                    .map(serde_json::from_value::<super::capture_pins::SelectionFrame>)
                    .transpose()
                    .map_err(|e| e.to_string())?;
                let cover = super::capture_pin_handoff::SelectionCover::retain_source(
                    app,
                    &window,
                    r,
                    native::decode(request.image.as_deref().ok_or("缺少钉图留屏画面")?)?,
                    frame,
                )?;
                // Keep keyboard cancellation available on the source's input
                // surface. React clears its canvases under the native pixels.
                native::retain_pin_selection(&window, cover.hwnd()?, cover.rect)?;
                Some(cover)
            } else {
                native::clear_hit_regions(&window)?;
                None
            };
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|s| s.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            if let Some(previous) = session.pin_cover.take() {
                previous.close();
            }
            session.pin_cover = cover;
            session.interaction = None;
            Ok(Value::Null)
        }
        "dismiss" => {
            // Keep the session for export/retry but remove its frozen desktop immediately.
            withdraw(app, label);
            Ok(Value::Null)
        }
        "cancel" => {
            // Remove the pin immediately, before disk cleanup and settings I/O.
            withdraw(app, label);
            if label.starts_with("capture-pin-") {
                if let Err(error) = forget_pin(app, label, Some(&request.id)) {
                    let _ = ready(app, label, &request.id);
                    return Err(error);
                }
            }
            let saved = save_preferences(app, request.preferences);
            close_session(app, label, Some(&request.id));
            if let Err(error) = saved {
                report_capture_error(app, &format!("截图工具设置保存失败：{error}"));
            }
            Ok(Value::Null)
        }
        "load_failed" => {
            let pending_pin = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .is_some_and(|s| s.pin_handoff.is_some());
            close_session(app, label, Some(&request.id));
            // A pending pin reports its failure to the retained capture through
            // the completion channel. Do not reveal a settings window under it.
            if !pending_pin {
                report_capture_error(
                    app,
                    if label == "capture" {
                        "截图加载失败，请重试。"
                    } else if label.starts_with("capture-scan-") {
                        "扫码结果加载失败，请重试。"
                    } else {
                        "钉图加载失败，请重试。"
                    },
                );
            }
            Ok(Value::Null)
        }
        "element_at" => {
            let value = request.value.ok_or("缺少指针坐标")?;
            let x = value["x"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or("无效坐标")?;
            let y = value["y"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or("无效坐标")?;
            Ok(json!(super::capture_platform::element_at(x, y)))
        }
        "nudge" => {
            let value = request.value.ok_or("缺少微调方向")?;
            let dx = value["x"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or("无效方向")?;
            let dy = value["y"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or("无效方向")?;
            let (x, y) = super::capture_platform::move_cursor(dx, dy)?;
            Ok(json!({ "x": x, "y": y }))
        }
        "refresh" => {
            if label != "capture" {
                return Err("仅截图窗口可刷新背景".into());
            }
            let window = app.get_webview_window(label).ok_or("截图窗口已关闭")?;
            // WDA_EXCLUDEFROMCAPTURE alone is backend/Windows dependent. Withdraw
            // the full-screen WebView and flush DWM before requesting a fresh frame.
            // The renderer calls ready only after the new canvas has been painted.
            let result = super::lifecycle::capture_without_reference_peer(Some(&window), || {
                check(app, label, &request.id)?;
                let mut image = native::capture(
                    snapshot.bounds,
                    option(&snapshot, "capture_engine")
                        .as_str()
                        .unwrap_or("auto"),
                )?;
                if option(&snapshot, "capture_include_cursor")
                    .as_bool()
                    .unwrap_or(false)
                {
                    super::capture_platform::include_cursor(&mut image, snapshot.bounds)?;
                }
                let image = native::data_url(&image)?;
                let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                let session = sessions
                    .get_mut(label)
                    .filter(|s| s.snapshot.id == request.id)
                    .ok_or("截图会话已结束")?;
                session.snapshot.image = image.clone();
                Ok(json!({"image": image}))
            });
            if result.is_err() {
                let _ = ready(app, label, &request.id);
            }
            result
        }
        "options" => {
            let value = request.value.ok_or("缺少截图设置")?;
            super::commands::save_capture_preferences(app, value.clone())?;
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(session) = sessions
                .get_mut(label)
                .filter(|session| session.snapshot.id == request.id)
            {
                if let (Some(options), Some(patch)) =
                    (session.snapshot.options.as_object_mut(), value.as_object())
                {
                    options.extend(patch.clone());
                }
            }
            Ok(Value::Null)
        }
        "tools" => {
            let value = request.value.ok_or("缺少工具设置")?;
            super::commands::save_capture_configuration(app, json!({}), Some(value))?;
            Ok(Value::Null)
        }
        "copy" | "confirm" | "save" | "pin" | "copy_pin" => {
            let is_pin = matches!(request.action.as_str(), "pin" | "copy_pin");
            if label == "capture" && !is_pin {
                withdraw(app, label);
            }
            let result = (|| {
                save_preferences(app, request.preferences)?;
                let image = native::decode(request.image.as_deref().ok_or("缺少截图")?)?;
                let pin_source = if matches!(request.action.as_str(), "pin" | "copy_pin") {
                    let marks = request.value.unwrap_or(Value::Null);
                    crate::domain::capture::validate_marks(&marks)?;
                    if serde_json::to_vec(&marks).map_err(|e| e.to_string())?.len() > 8_000_000 {
                        return Err("钉图标注数据过大".into());
                    }
                    snapshot.marks = marks;
                    Some((
                        request
                            .pin_image
                            .as_deref()
                            .map(native::decode)
                            .transpose()?,
                        request.rect.ok_or("缺少钉图位置")?.validate()?,
                    ))
                } else {
                    None
                };
                let mut path = None;
                if request.action == "save" {
                    path = save_image(app, &snapshot, &image, true)?;
                    if path.is_none() {
                        return Ok(json!({"cancelled": true}));
                    }
                } else if matches!(
                    request.action.as_str(),
                    "confirm" | "copy" | "pin" | "copy_pin"
                ) {
                    if option(&snapshot, "screenshot_save_enabled")
                        .as_bool()
                        .unwrap_or(true)
                    {
                        path = save_image(app, &snapshot, &image, false)?;
                    }
                    copy_result(app, &snapshot, &image, path.as_deref())?;
                }
                if let Some((base, region)) = pin_source {
                    // Clipboard/file receive the composed result; the pin retains a
                    // clean background and editable marks, avoiding double drawing.
                    pin(
                        app,
                        &snapshot,
                        base.as_ref().unwrap_or(&image),
                        region,
                        (label == "capture").then_some(request.id.as_str()),
                    )?;
                }
                if label == "capture" && !is_pin {
                    close_session(app, label, Some(&request.id));
                }
                Ok(json!({"path": path}))
            })();
            if label == "capture"
                && (result.is_err()
                    || result
                        .as_ref()
                        .is_ok_and(|value| value["cancelled"] == true))
            {
                let _ = ready(app, label, &request.id);
            }
            result
        }
        "scan" => {
            if label != "capture" {
                return Err("请从截图选区开始扫码".into());
            }
            withdraw(app, label);
            let image = native::decode(request.image.as_deref().ok_or("缺少截图")?)?;
            save_preferences(app, request.preferences)?;
            let result_label = open_scan(
                app,
                &snapshot,
                request.rect.ok_or("缺少扫码选区")?.validate()?,
            )?;
            close_session(app, label, Some(&request.id));
            let results = native::scan(image);
            let copy_error = if results.len() == 1
                && option(&snapshot, "barcode_copy_single")
                    .as_bool()
                    .unwrap_or(false)
            {
                arboard::Clipboard::new()
                    .map_err(|e| e.to_string())
                    .and_then(|mut c| {
                        c.set_text(results[0]["text"].as_str().unwrap_or(""))
                            .map_err(|e| e.to_string())
                    })
                    .err()
                    .map(|error| format!("识别成功，复制失败：{error}"))
            } else {
                None
            };
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(session) = sessions.get_mut(&result_label) {
                session.snapshot.scan_results = Some(results);
                session.snapshot.scan_error = copy_error;
                drop(sessions);
                app.emit_to(&result_label, "capture:session", ())
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "scan_again" => {
            if !label.starts_with("capture-scan-") {
                return Err("仅扫码结果窗口可重新扫码".into());
            }
            close_session(app, label, Some(&request.id));
            if let Err(error) = self::request(app, "scan") {
                report_capture_error(app, &format!("无法开始扫码：{error}"));
            }
            Ok(Value::Null)
        }
        "copy_text" => {
            let value = request.value.ok_or("缺少文字")?;
            let text = value.as_str().ok_or("文字格式无效")?;
            arboard::Clipboard::new()
                .map_err(|e| e.to_string())?
                .set_text(text)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "open_link" => {
            let value = request.value.ok_or("缺少链接")?;
            crate::platform::windows::external::open(value.as_str().ok_or("无效链接")?)?;
            Ok(Value::Null)
        }
        "pin_metrics" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let window = app.get_webview_window(label).ok_or("钉图已关闭")?;
            let origin = window.outer_position().map_err(|e| e.to_string())?;
            let monitor = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("未找到屏幕")?;
            Ok(
                json!({"x": origin.x, "y": origin.y, "screen": {"x": monitor.position().x, "y": monitor.position().y, "width": monitor.size().width, "height": monitor.size().height}}),
            )
        }
        "pin_resize" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let value = request.value.ok_or("缺少尺寸")?;
            let width = value["width"].as_u64().ok_or("无效宽度")?.clamp(1, 32768) as u32;
            let height = value["height"].as_u64().ok_or("无效高度")?.clamp(1, 32768) as u32;
            let dx = value["dx"].as_i64().unwrap_or(0).clamp(-32768, 32768) as i32;
            let dy = value["dy"].as_i64().unwrap_or(0).clamp(-32768, 32768) as i32;
            let window = app.get_webview_window(label).ok_or("钉图已关闭")?;
            let surface = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .and_then(|s| s.pin_cover.clone());
            if let (Some(surface), Some(area)) = (surface, request.rect) {
                let origin = window.outer_position().map_err(|e| e.to_string())?;
                surface.resize_host(
                    &window,
                    Rect {
                        x: origin.x.saturating_add(dx),
                        y: origin.y.saturating_add(dy),
                        width,
                        height,
                    },
                    area.validate()?,
                )?;
                return Ok(Value::Null);
            }
            if dx != 0 || dy != 0 {
                let origin = window.outer_position().map_err(|e| e.to_string())?;
                window
                    .set_position(PhysicalPosition::new(
                        origin.x.saturating_add(dx),
                        origin.y.saturating_add(dy),
                    ))
                    .map_err(|e| e.to_string())?;
            }
            window
                .set_size(PhysicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "pin_interaction" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let rects: Vec<Rect> = serde_json::from_value(request.value.ok_or("缺少区域")?)
                .map_err(|e| e.to_string())?;
            let window = app.get_webview_window(label).ok_or("钉图已关闭")?;
            super::capture_native::set_hit_regions(&window, &rects)?;
            Ok(Value::Null)
        }
        "pin_state" => {
            if !label.starts_with("capture-pin-") {
                return Err("仅适用于钉图".into());
            }
            let state: super::capture_pins::State =
                serde_json::from_value(request.value.ok_or("缺少钉图属性")?)
                    .map_err(|e| e.to_string())?;
            persist_pin(app, label, Some((&request.id, state)))?;
            Ok(Value::Null)
        }
        "interaction" => {
            // Shape changes must not race a live sample's temporary exclusion.
            let gate = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .filter(|s| s.snapshot.id == request.id)
                .ok_or("截图已关闭")?
                .scroll_gate
                .clone();
            let _guard = gate.lock().map_err(|e| e.to_string())?;
            check(app, label, &request.id)?;
            // A queued observation from the removed toolbar cannot expand the
            // retained source region or expose the old full-screen canvas again.
            if manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .is_some_and(|s| s.pin_cover.is_some())
            {
                return Ok(Value::Null);
            }
            let value = request.value.ok_or("缺少窗口区域")?;
            let rects: Vec<Rect> =
                serde_json::from_value(value["regions"].clone()).map_err(|e| e.to_string())?;
            if rects.len() > 64 {
                return Err("交互区域过多".into());
            }
            for rect in &rects {
                rect.validate()?;
            }
            let surface: Option<Vec<Rect>> =
                serde_json::from_value(value["surface"].clone()).map_err(|e| e.to_string())?;
            let window = app.get_webview_window(label).ok_or("截图已关闭")?;
            if let Some(surface) = surface {
                let local = surface
                    .into_iter()
                    .map(|r| Rect {
                        x: r.x - snapshot.bounds.x,
                        y: r.y - snapshot.bounds.y,
                        ..r
                    })
                    .collect::<Vec<_>>();
                native::set_hit_regions(&window, &local)?;
            } else {
                native::clear_hit_regions(&window)?;
            }
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|s| s.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            session.scroll_live =
                session.scroll.is_some() && value["scroll"].as_bool().unwrap_or(false);
            session.interaction = if value["passthrough"].as_bool().unwrap_or(false) {
                Some(rects)
            } else {
                None
            };
            drop(sessions);
            if !value["passthrough"].as_bool().unwrap_or(false) {
                window
                    .set_ignore_cursor_events(false)
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "record_start" => {
            let rect = request.rect.ok_or("缺少录制区域")?.validate()?;
            let fps = request
                .value
                .as_ref()
                .and_then(|v| v["fps"].as_u64())
                .unwrap_or(10)
                .clamp(1, 60) as u32;
            let cursor = super::capture_cursor::Track::new(
                request.value.as_ref().and_then(|v| v.get("sprites")),
            )?;
            let frames = Arc::new(FrameStore::new(
                rect.width,
                rect.height,
                fps,
                RecordConfig {
                    jpeg_quality: 95,
                    max_frames: 60000,
                    max_memory_bytes: 1024 * 1024 * 1024,
                },
            ));
            // Like the upstream transparent drawing window, recording captures
            // the live desktop and annotations together. A protected full-screen
            // WebView can instead be returned as a black surface by DXGI/GDI.
            let window = app.get_webview_window(label).ok_or("录制窗口已关闭")?;
            native::allow_recording_capture(&window)?;
            let recorder = RecordSession::start(
                frames.clone(),
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                fps,
                option(&snapshot, "capture_engine") != "mss",
            )?;
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|session| session.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            if let Some(mut old) = session.recorder.take() {
                old.stop();
            }
            session.region = Some(rect);
            session.frames = Some(frames);
            session.recorder = Some(recorder);
            session.cursor = cursor;
            Ok(Value::Null)
        }
        "record_pause" | "record_resume" | "record_stop" | "record_status" => {
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|session| session.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            let recorder = session.recorder.as_mut().ok_or("尚未开始录制")?;
            match request.action.as_str() {
                "record_pause" => recorder.pause(),
                "record_resume" => recorder.resume(),
                "record_stop" => recorder.stop(),
                _ => {}
            }
            let frames = session.frames.as_ref().ok_or("没有录制帧")?;
            Ok(
                json!({"count":frames.frame_count(),"duration":frames.total_duration_ms(),"bytes":frames.memory_usage_bytes(),"dropped":frames.dropped_frames(),"state":recorder.state(),"timestamps":if request.action == "record_stop" {frames.frame_timestamps()} else {vec![]}}),
            )
        }
        "scroll_start" => {
            let rect = request.rect.ok_or("缺少长截图区域")?.validate()?;
            let mut engine = option(&snapshot, "capture_engine")
                .as_str()
                .unwrap_or("auto")
                .to_owned();
            let window = app.get_webview_window(label).ok_or("截图已关闭")?;
            // Start with a fresh live frame, using the same backend for all frames.
            // The full-screen reference image may have used a different fallback.
            let captured = super::lifecycle::capture_without_reference_peer(Some(&window), || {
                super::capture_scroll::capture(rect, &mut engine)
            });
            let image = match captured {
                Ok(image) => image,
                Err(error) => {
                    let _ = ready(app, label, &request.id);
                    return Err(error);
                }
            };
            // The shaped live window has a real hole over the capture rectangle.
            // Disabling full-HWND protection prevents backend-dependent black pixels.
            if let Err(error) = native::allow_recording_capture(&window) {
                let _ = ready(app, label, &request.id);
                return Err(error);
            }
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|session| session.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            if image.width() != rect.width || image.height() != rect.height {
                return Err("长截图与选区尺寸不匹配".into());
            }
            session.region = Some(rect);
            session.scroll = Some(image);
            session.scroll_count = 1;
            session.horizontal = false;
            session.scroll_trigger = Default::default();
            session.scroll_engine = engine;
            session.scroll_live = false;
            Ok(Value::Null)
        }
        "scroll_direction" => {
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|session| session.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            if session.scroll_count > 1 {
                return Err("已开始拼接，请重新开始后切换方向".into());
            }
            session.horizontal = request
                .value
                .as_ref()
                .and_then(Value::as_bool)
                .unwrap_or(false);
            session.scroll_trigger = Default::default();
            Ok(Value::Null)
        }
        "scroll_step" | "scroll_poll" | "scroll_finish" | "scroll_preview" => {
            let gate = manager
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get(label)
                .filter(|s| s.snapshot.id == request.id)
                .ok_or("截图已关闭")?
                .scroll_gate
                .clone();
            let _guard = gate.lock().map_err(|e| e.to_string())?;
            let viewport = request.value.as_ref();
            let preview_width = viewport
                .and_then(|v| v["width"].as_u64())
                .unwrap_or(600)
                .clamp(1, 8192) as u32;
            let preview_height = viewport
                .and_then(|v| v["height"].as_u64())
                .unwrap_or(1200)
                .clamp(1, 8192) as u32;
            if u64::from(preview_width) * u64::from(preview_height) > 16_000_000 {
                return Err("长截图预览尺寸过大".into());
            }
            let (rect, previous, horizontal, mut engine, count, settle) = {
                let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
                let session = sessions
                    .get_mut(label)
                    .filter(|session| session.snapshot.id == request.id)
                    .ok_or("截图已关闭")?;
                if request.action != "scroll_preview" && !session.scroll_live {
                    return if request.action == "scroll_poll" {
                        Ok(Value::Null)
                    } else {
                        Err("长截图正在准备，请稍后重试".into())
                    };
                }
                let cooldown = Duration::from_secs_f64(
                    option(&snapshot, "scroll_cooldown")
                        .as_f64()
                        .unwrap_or(0.15)
                        .clamp(0.01, 5.0),
                );
                if request.action == "scroll_poll" {
                    if !session.scroll_trigger.due(cooldown) {
                        return Ok(Value::Null);
                    }
                } else if request.action == "scroll_step" {
                    session.scroll_trigger.manual();
                }
                (
                    session.region.ok_or("未开始长截图")?,
                    session.scroll.clone().ok_or("未开始长截图")?,
                    session.horizontal,
                    session.scroll_engine.clone(),
                    session.scroll_count,
                    session.scroll_trigger.settle_delay(cooldown),
                )
            };
            if request.action == "scroll_preview" {
                return Ok(
                    json!({"preview":native::data_url(&super::capture_scroll::preview(&previous,horizontal,preview_width,preview_height))?,"width":previous.width(),"height":previous.height(),"count":count,"changed":false,"noOverlap":false}),
                );
            }
            // Finishing also samples the final desktop frame, after any ongoing
            // stitch. Never export an old initial image while a poll is in flight.
            if request.action == "scroll_finish" {
                std::thread::sleep(settle);
            }
            let window = app.get_webview_window(label).ok_or("截图已关闭")?;
            let local = Rect {
                x: rect.x - snapshot.bounds.x,
                y: rect.y - snapshot.bounds.y,
                ..rect
            };
            // Never hide/show the full window per frame. The normal surface is a
            // hollow border plus controls. Only overlapping controls need clipping
            // for a sample (e.g. after dragging the toolbar into the selection).
            let frame = native::capture_through_region(&window, local, || {
                check(app, label, &request.id)?;
                super::capture_scroll::capture(rect, &mut engine)
            })?;
            let joined = super::capture_scroll::join(
                &previous,
                &frame,
                horizontal,
                option(&snapshot, "long_stitch_ignore_top_pixels")
                    .as_u64()
                    .unwrap_or(0) as u32,
            )?;
            let no_overlap = joined.is_none();
            let image = joined.unwrap_or(previous.clone());
            let changed = image.dimensions() != previous.dimensions();
            let (width, height) = image.dimensions();
            let preview = if request.action == "scroll_finish" {
                String::new()
            } else {
                native::data_url(&super::capture_scroll::preview(
                    &image,
                    horizontal,
                    preview_width,
                    preview_height,
                ))?
            };
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions
                .get_mut(label)
                .filter(|s| s.snapshot.id == request.id)
                .ok_or("截图已关闭")?;
            if changed {
                session.scroll_count += 1;
                session.scroll = Some(image);
            }
            if request.action == "scroll_finish" {
                if no_overlap {
                    return Err("最后一帧未能拼接，请回滚少许后缓慢滚动再试".into());
                }
                let image = session.scroll.as_ref().ok_or("未开始长截图")?;
                return Ok(json!({"image":native::data_url(image)?,"width":width,"height":height}));
            }
            Ok(
                json!({"width":width,"height":height,"count":session.scroll_count,"changed":changed,"noOverlap":no_overlap,"preview":preview}),
            )
        }
        _ => Err("未知截图操作".into()),
    }
}
pub fn frame(
    app: &AppHandle,
    label: &str,
    id: &str,
    index: usize,
    show_cursor: bool,
) -> Result<Vec<u8>, String> {
    check(app, label, id)?;
    let manager = app.state::<CaptureManager>();
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(label)
        .filter(|session| session.snapshot.id == id)
        .ok_or("录制已关闭")?;
    let frames = session.frames.as_ref().ok_or("没有录制帧")?;
    let frames = frames.clone();
    let sprites = session.cursor.sprites.clone();
    let cursor = session
        .cursor
        .samples
        .get(index)
        .or_else(|| session.cursor.samples.last())
        .cloned();
    drop(sessions);
    let rgb = frames.get_frame_rgb(index, 0, 0)?;
    let rgb =
        image::RgbImage::from_raw(frames.width(), frames.height(), rgb).ok_or("录制帧无效")?;
    let mut image = image::DynamicImage::ImageRgb8(rgb).into_rgba8();
    if show_cursor {
        super::capture_cursor::compose(&mut image, &sprites, cursor.as_ref());
    }
    native::png(&image)
}
pub fn cancel(app: &AppHandle) {
    let manager = app.state::<CaptureManager>();
    manager.stopping.store(true, Ordering::Release);
    manager.export_cancelled.store(true, Ordering::Release);
    let labels = manager
        .sessions
        .lock()
        .map(|s| s.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for label in labels {
        if label.starts_with("capture-pin-") {
            let _ = persist_pin(app, &label, None);
        }
        close(app, &label);
    }
}
pub fn warm_up(app: AppHandle) {
    // Build the transparent WebView once; no screen capture until requested.
    if let Ok(bounds) = native::desktop_rect() {
        let _ = build_window(&app, "capture", bounds);
    }
    super::capture_input::start(app.clone());
    std::thread::spawn(move || {
        if let Err(error) = restore_pins(&app) {
            report_capture_error(&app, &format!("钉图恢复失败：{error}"));
        }
        let mut last = HashMap::new();
        loop {
            let manager = app.state::<CaptureManager>();
            if manager.stopping.load(Ordering::Acquire) {
                break;
            }
            let moved = manager
                .pin_moves
                .lock()
                .map(|mut moves| {
                    let labels = moves
                        .iter()
                        .filter(|(_, at)| at.elapsed() >= Duration::from_millis(250))
                        .map(|(label, _)| label.clone())
                        .collect::<Vec<_>>();
                    for label in &labels {
                        moves.remove(label);
                    }
                    labels
                })
                .unwrap_or_default();
            for label in moved {
                if let Err(error) = persist_pin(&app, &label, None) {
                    report_capture_error(&app, &format!("钉图位置保存失败：{error}"));
                }
            }
            let expired = manager
                .sessions
                .lock()
                .map(|sessions| {
                    sessions
                        .iter()
                        .filter(|(_, s)| !s.ready && s.created.elapsed() > Duration::from_secs(20))
                        .map(|(label, session)| {
                            (
                                label.clone(),
                                session.snapshot.id.clone(),
                                session.pin_handoff.is_some(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (label, id, pending_pin) in expired {
                close_session(&app, &label, Some(&id));
                if !pending_pin {
                    report_capture_error(&app, "截图窗口加载超时，请重试。");
                }
            }
            let mut point = windows::Win32::Foundation::POINT::default();
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point);
            }
            let mut hit_updates = Vec::new();
            if let Ok(mut sessions) = manager.sessions.lock() {
                for (label, session) in sessions.iter_mut() {
                    // Pins already use a shaped input window. They do not need
                    // Tao's layered-window passthrough/style rewrites.
                    if label.starts_with("capture-pin-") {
                        continue;
                    }
                    if session.recorder.as_ref().is_some_and(|r| r.is_recording()) {
                        if let (Some(rect), Some(frames)) = (session.region, &session.frames) {
                            session
                                .cursor
                                .sample(frames.frame_count(), rect, point.x, point.y);
                        }
                    }
                    if session.dialog_open {
                        last.remove(label);
                        continue;
                    }
                    let hit = session.interaction.as_ref().is_none_or(|regions| {
                        regions.iter().any(|r| {
                            point.x >= r.x
                                && point.y >= r.y
                                && i64::from(point.x) < i64::from(r.x) + i64::from(r.width)
                                && i64::from(point.y) < i64::from(r.y) + i64::from(r.height)
                        })
                    });
                    let key = (session.snapshot.id.clone(), hit);
                    if last.get(label) != Some(&key) {
                        hit_updates.push((label.clone(), key));
                    }
                }
            }
            // Never dispatch window work while holding the session mutex:
            // WebView commands and modal dialogs may need the same state.
            for (label, (id, hit)) in hit_updates {
                if check(&app, &label, &id).is_ok() {
                    if let Some(window) = app.get_webview_window(&label) {
                        if window.set_ignore_cursor_events(!hit).is_ok() {
                            last.insert(label, (id, hit));
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(12));
        }
    });
}
pub fn stopped(app: &AppHandle) -> bool {
    app.state::<CaptureManager>()
        .stopping
        .load(Ordering::Acquire)
}
pub fn quick_start(app: &AppHandle, rect: Rect, mode: &str) -> Result<(), String> {
    if mode == "edit" {
        if app
            .state::<CaptureManager>()
            .busy
            .swap(true, Ordering::AcqRel)
        {
            return Ok(());
        }
        let result = start_session(app, "image", Some(rect), None);
        if result.is_err() {
            restore(app);
        }
        return result;
    }
    let settings = options(app)?;
    let mut image = native::capture(rect, settings["capture_engine"].as_str().unwrap_or("auto"))?;
    if settings["capture_include_cursor"]
        .as_bool()
        .unwrap_or(false)
    {
        super::capture_platform::include_cursor(&mut image, rect)?;
    }
    let source = Snapshot {
        id: String::new(),
        mode: "pin".into(),
        bounds: rect,
        screens: vec![native::desktop_rect()?],
        image: String::new(),
        options: settings,
        tools: json!({}),
        windows: Vec::new(),
        selection: None,
        marks: Value::Null,
        pin_state: None,
        scan_results: None,
        scan_error: None,
    };
    if matches!(mode, "copy" | "pin" | "copy_pin") {
        let path = if option(&source, "screenshot_save_enabled")
            .as_bool()
            .unwrap_or(true)
        {
            save_image(app, &source, &image, false)?
        } else {
            None
        };
        copy_result(app, &source, &image, path.as_deref())?;
    }
    if matches!(mode, "pin" | "copy_pin") {
        pin(app, &source, &image, rect, None)?;
    }
    Ok(())
}
