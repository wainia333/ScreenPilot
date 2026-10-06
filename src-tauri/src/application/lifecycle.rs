use crate::application::state::{AppState, MainRoute, ReferenceSurface};
use crate::domain::settings::{AppSettings, InterfaceLanguage};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const TRANSLATOR_WIDTH: f64 = 680.0;
pub(crate) const TRANSLATOR_HEIGHT: f64 = 400.0;
type PhysicalPoint = (i32, i32);
type MonitorGeometry = (i32, i32, i32, i32, f64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FeatureSurface {
    Main,
    Translator,
    Vision,
    Ocr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum HotkeyAction {
    Capture,
    Translator,
    Vision,
    ScreenshotTranslation,
    PromptOptimizer,
}

impl HotkeyAction {
    fn scope(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Translator => "translator",
            Self::Vision => "vision",
            Self::ScreenshotTranslation => "screenshot_translation",
            Self::PromptOptimizer => "prompt_optimizer",
        }
    }
}

static HOTKEY_LAST_TRIGGERED: OnceLock<Mutex<HashMap<&'static str, Instant>>> = OnceLock::new();

fn accept_hotkey_trigger(action: HotkeyAction) -> bool {
    const SUPPRESS_DUPLICATE_WITHIN: Duration = Duration::from_millis(300);
    let now = Instant::now();
    let mut last_triggered = HOTKEY_LAST_TRIGGERED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(last) = last_triggered.get(action.scope()) {
        if now.duration_since(*last) < SUPPRESS_DUPLICATE_WITHIN {
            return false;
        }
    }
    last_triggered.insert(action.scope(), now);
    true
}

fn hidden_surfaces_for(target: FeatureSurface) -> &'static [FeatureSurface] {
    match target {
        FeatureSurface::Main => &[
            FeatureSurface::Translator,
            FeatureSurface::Vision,
            FeatureSurface::Ocr,
        ],
        FeatureSurface::Translator => &[
            FeatureSurface::Main,
            FeatureSurface::Vision,
            FeatureSurface::Ocr,
        ],
        FeatureSurface::Vision | FeatureSurface::Ocr => {
            &[FeatureSurface::Main, FeatureSurface::Translator]
        }
    }
}

fn prepare_feature_surface(app: &AppHandle, target: FeatureSurface) -> Result<(), String> {
    for surface in hidden_surfaces_for(target) {
        match surface {
            FeatureSurface::Main => {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().map_err(|error| error.to_string())?;
                }
            }
            FeatureSurface::Translator => {
                if let Some(window) = app.get_webview_window("translator") {
                    hide_translator_surface(&window)?;
                    normalize_translator_window(&window)?;
                }
            }
            FeatureSurface::Vision => {
                crate::application::commands::close_reference_vision_surface(app)?;
            }
            FeatureSurface::Ocr => {
                crate::application::commands::close_reference_surface(app, ReferenceSurface::Ocr)?;
            }
        }
    }
    if matches!(target, FeatureSurface::Vision | FeatureSurface::Ocr) {
        flush_windows_compositor();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn flush_windows_compositor() {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    let _ = unsafe { DwmFlush() };
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn flush_windows_compositor() {}

fn hide_translator_surface(window: &WebviewWindow) -> Result<(), String> {
    window.state::<AppState>().cancel_active_text_commit();
    window.state::<AppState>().clear_translator_paste_target()?;
    hide_translator_with(
        &window.state::<AppState>(),
        || force_hide_window(window),
        || window.hide().map_err(|error| error.to_string()),
    )?;
    wait_for_translator_withdrawn(window);
    Ok(())
}

fn hide_translator_with(
    state: &AppState,
    force_hide: impl FnOnce(),
    framework_hide: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    state.cancel_active_translator_request();
    force_hide();
    framework_hide()
}

pub(crate) fn close_translator_window(
    window: WebviewWindow,
) -> tauri::async_runtime::JoinHandle<Result<(), String>> {
    let generation = window.state::<AppState>().begin_surface_action();
    tauri::async_runtime::spawn_blocking(move || {
        window
            .state::<AppState>()
            .with_current_surface_action(generation, || hide_translator_surface(&window))
            .map(|_| ())
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn force_hide_window(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        force_hide_hwnd(hwnd);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn force_hide_window(_window: &WebviewWindow) {}

#[cfg(target_os = "windows")]
fn force_hide_hwnd(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
}

pub(crate) fn capture_without_reference_peer<T>(
    peer: Option<&WebviewWindow>,
    capture: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(peer) = peer else {
        return capture();
    };
    #[cfg(target_os = "windows")]
    let hwnd = peer.hwnd().map_err(|error| error.to_string())?;
    capture_after_withdrawal(
        || {
            #[cfg(target_os = "windows")]
            disable_capture_window_transitions(hwnd)?;
            force_hide_window(peer);
            peer.hide().map_err(|error| error.to_string())
        },
        || {
            #[cfg(target_os = "windows")]
            {
                capture_window_is_withdrawn(hwnd)
            }
            #[cfg(not(target_os = "windows"))]
            {
                peer.is_visible()
                    .map(|visible| !visible)
                    .map_err(|error| error.to_string())
            }
        },
        || {
            #[cfg(target_os = "windows")]
            unsafe {
                windows::Win32::Graphics::Dwm::DwmFlush().map_err(|error| {
                    format!("Reference window compositor flush failed: {error}")
                })?;
            }
            Ok(())
        },
        capture,
    )
}

fn capture_after_withdrawal<T>(
    withdraw: impl FnOnce() -> Result<(), String>,
    mut is_withdrawn: impl FnMut() -> Result<bool, String>,
    flush: impl FnOnce() -> Result<(), String>,
    capture: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    withdraw()?;
    if !is_withdrawn()? {
        return Err("Reference window is still visible; capture aborted".to_string());
    }
    flush()?;
    if !is_withdrawn()? {
        return Err("Reference window became visible before capture".to_string());
    }
    capture()
}

#[cfg(target_os = "windows")]
pub(crate) fn disable_capture_window_transitions(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let disabled = BOOL::from(true);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disabled as *const _ as *const _,
            std::mem::size_of::<BOOL>() as u32,
        )
        .map_err(|error| format!("Disable reference window transitions failed: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn capture_window_is_withdrawn(hwnd: windows::Win32::Foundation::HWND) -> Result<bool, String> {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible};
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("Reference window is unavailable; capture aborted".to_string());
        }
        Ok(!IsWindowVisible(hwnd).as_bool())
    }
}

#[cfg(target_os = "windows")]
fn wait_for_translator_withdrawn(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(180) {
        let visible = window
            .hwnd()
            .map(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() })
            .unwrap_or(false);
        if !visible {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    flush_windows_compositor();
    thread::sleep(Duration::from_millis(40));
    flush_windows_compositor();
}

#[cfg(not(target_os = "windows"))]
fn wait_for_translator_withdrawn(_window: &WebviewWindow) {}

fn normalize_translator_window(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_fullscreen(false)
        .map_err(|error| error.to_string())?;
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(TRANSLATOR_WIDTH, TRANSLATOR_HEIGHT))
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessActivation {
    Initial,
    Repeated,
}

fn automatic_route(_activation: ProcessActivation) -> Option<MainRoute> {
    None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MainNavigationAction {
    FocusCurrent,
    ApplyDirectly,
    AskSettingsGuard,
}

fn main_navigation_action(
    current: MainRoute,
    requested: MainRoute,
    visible: bool,
) -> MainNavigationAction {
    if !visible {
        // Every hidden-window entrance is a fresh popup: restore the route's
        // size and position and replay its mount animation even when the
        // native route already matches. Treating this as focus-only leaves a
        // closed Settings window at its dragged position and a closed
        // optimizer at the previous cursor position.
        MainNavigationAction::ApplyDirectly
    } else if current == requested {
        MainNavigationAction::FocusCurrent
    } else {
        MainNavigationAction::AskSettingsGuard
    }
}

fn activate_process(app: &AppHandle, activation: ProcessActivation) -> Result<(), String> {
    match automatic_route(activation) {
        Some(route) => show_main(app, route),
        None => Ok(()),
    }
}

impl MainRoute {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::PromptOptimizer => "prompt-optimizer",
        }
    }

    fn size(self) -> (f64, f64) {
        match self {
            Self::Settings => (844.0, 620.0),
            Self::PromptOptimizer => (680.0, 450.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct MainNavigationRequest {
    #[serde(rename = "requestId")]
    request_id: u64,
    route: &'static str,
}

pub(crate) fn pending_main_navigation(
    state: &AppState,
) -> Result<Option<MainNavigationRequest>, String> {
    state.pending_main_navigation().map(|pending| {
        pending.map(|(request_id, route)| MainNavigationRequest {
            request_id,
            route: route.name(),
        })
    })
}

pub fn show_main(app: &AppHandle, route: MainRoute) -> Result<(), String> {
    if route == MainRoute::PromptOptimizer
        && !app.state::<AppState>().current()?.prompt_optimizer.enabled
    {
        return Err("Prompt optimizer is disabled in settings".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    match main_navigation_action(app.state::<AppState>().main_route()?, route, visible) {
        MainNavigationAction::FocusCurrent => {
            // Re-opening the active main route preserves its React tree, but
            // still withdraws any translator/Vision peer first.
            prepare_feature_surface(app, FeatureSurface::Main)?;
            return show_and_focus(&window);
        }
        MainNavigationAction::ApplyDirectly => return apply_main_navigation(app, route),
        MainNavigationAction::AskSettingsGuard => {}
    }
    prepare_feature_surface(app, FeatureSurface::Main)?;
    // The guard lives in the existing main WebView. Reveal the current route
    // before asking for a decision, but do not reset or resize it yet.
    show_and_focus(&window)?;
    let (request_id, is_new) = app.state::<AppState>().begin_main_navigation(route)?;
    if is_new {
        window
            .emit(
                "screenpilot:main-navigation-request",
                MainNavigationRequest {
                    request_id,
                    route: route.name(),
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_main_navigation(app: &AppHandle, route: MainRoute) -> Result<(), String> {
    prepare_feature_surface(app, FeatureSurface::Main)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window
        .emit("screenpilot:reset", route.name())
        .map_err(|error| error.to_string())?;
    app.state::<AppState>().set_main_route(route)?;
    window
        .set_fullscreen(false)
        .map_err(|error| error.to_string())?;
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    let (width, height) = route.size();
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    match route {
        MainRoute::Settings => center_on_cursor_monitor(app, &window, width, height)?,
        MainRoute::PromptOptimizer => {
            let position = popup_window_position(app, width, height)?;
            window
                .set_position(position)
                .map_err(|error| error.to_string())?;
        }
    }
    window
        .emit("screenpilot:route", route.name())
        .map_err(|error| error.to_string())?;
    show_and_focus(&window)
}

pub fn acknowledge_main_navigation(
    app: &AppHandle,
    request_id: u64,
    accepted: bool,
) -> Result<(), String> {
    if let Some(route) = app
        .state::<AppState>()
        .acknowledge_main_navigation(request_id, accepted)?
    {
        apply_main_navigation(app, route)?;
    }
    Ok(())
}

fn toggle_optimizer_with(
    state: &AppState,
    visible: bool,
    hide: impl FnOnce() -> Result<(), String>,
    show: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !state.current()?.prompt_optimizer.enabled {
        return Err("Prompt optimizer is disabled in settings".into());
    }
    if visible && state.main_route()? == MainRoute::PromptOptimizer {
        state.cancel_active_optimizer_request();
        hide()
    } else {
        show()
    }
}

fn toggle_optimizer_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    toggle_optimizer_with(
        &app.state::<AppState>(),
        window.is_visible().map_err(|error| error.to_string())?,
        || hide_main_window(&window),
        || show_main(app, MainRoute::PromptOptimizer),
    )
}

fn hide_main_window(window: &WebviewWindow) -> Result<(), String> {
    force_hide_window(window);
    window.hide().map_err(|error| error.to_string())
}

pub(crate) fn close_main_window(
    window: WebviewWindow,
) -> tauri::async_runtime::JoinHandle<Result<(), String>> {
    let generation = window.state::<AppState>().begin_surface_action();
    tauri::async_runtime::spawn_blocking(move || {
        let state = window.state::<AppState>();
        state
            .with_current_surface_action(generation, || {
                state.cancel_active_optimizer_request();
                hide_main_window(&window)
            })
            .map(|_| ())
    })
}

pub fn show_translator(app: &AppHandle) -> Result<(), String> {
    app.state::<AppState>().cancel_active_text_commit();
    app.state::<AppState>().clear_translator_paste_target()?;
    show_translator_window(app, true, true)
}

fn show_translator_window(
    app: &AppHandle,
    activate: bool,
    reset_existing: bool,
) -> Result<(), String> {
    prepare_feature_surface(app, FeatureSurface::Translator)?;
    let window = prepare_translator_window(app, reset_existing)?;
    if activate {
        show_and_focus(&window)
    } else {
        show_without_activation(&window)
    }
}

fn prepare_translator_window(
    app: &AppHandle,
    reset_existing: bool,
) -> Result<WebviewWindow, String> {
    let (window, created) = ensure_translator_window(app)?;
    if !created && reset_existing {
        window
            .emit("screenpilot:reset", "translator")
            .map_err(|error| error.to_string())?;
    } else if !reset_existing {
        window
            .emit("screenpilot:translator-prepare", ())
            .map_err(|error| error.to_string())?;
    }
    normalize_translator_window(&window)?;
    let position = translator_popup_position(app)?;
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window
        .emit("screenpilot:route", "translator")
        .map_err(|error| error.to_string())?;
    Ok(window)
}

#[cfg(target_os = "windows")]
pub(crate) fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

fn show_and_focus(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    force_windows_foreground(window);
    Ok(())
}

#[cfg(target_os = "windows")]
fn force_windows_foreground(window: &WebviewWindow) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let foreground = GetForegroundWindow();
        let current_thread = GetCurrentThreadId();
        let foreground_thread = if foreground.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, None)
        };
        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
}

fn ensure_translator_window(app: &AppHandle) -> Result<(WebviewWindow, bool), String> {
    if let Some(window) = app.get_webview_window("translator") {
        return Ok((window, false));
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "translator")
        .ok_or("Translator window configuration is missing")?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| error.to_string())?
        .data_directory(app.state::<AppState>().webview_data_directory.clone())
        .build()
        .map_err(|error| error.to_string())?;
    Ok((window, true))
}

pub fn preload_translator_window(app: &AppHandle) -> Result<(), String> {
    let (window, _) = ensure_translator_window(app)?;
    window.hide().map_err(|error| error.to_string())
}

pub fn show_vision(
    app: &AppHandle,
    mode: &'static str,
    surface_generation: u64,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _settings_write = state.lock_settings_write()?;
    let settings = state.current()?;
    crate::application::commands::ensure_reference_mode_enabled(&settings, mode)?;
    if !state.accept_reference_surface_action(ReferenceSurface::for_mode(mode), surface_generation)
    {
        return Ok(());
    }
    prepare_feature_surface(
        app,
        if mode == "translate" {
            FeatureSurface::Ocr
        } else {
            FeatureSurface::Vision
        },
    )?;
    crate::application::commands::open_reference_vision(app, mode, surface_generation)
}

pub fn request_vision(app: &AppHandle, mode: &'static str) -> Result<(), String> {
    if super::capture_service::busy(app) {
        return Err("请先完成当前截图 / Finish the active capture first".into());
    }
    let state = app.state::<AppState>();
    let Some(generation) = state.begin_vision_surface_action(mode) else {
        return Ok(());
    };
    state
        .with_current_surface_action(generation, || show_vision(app, mode, generation))
        .map(|_| ())
}

fn run_surface_action(
    app: &AppHandle,
    action: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let generation = state.begin_surface_action();
    state
        .with_current_surface_action(generation, action)
        .map(|_| ())
}

fn translator_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("translator")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn hide_visible_translator_for_toggle(app: &AppHandle) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("translator") else {
        return Ok(false);
    };
    if !window.is_visible().unwrap_or(false) {
        return Ok(false);
    }
    hide_translator_surface(&window)?;
    normalize_translator_window(&window)?;
    Ok(true)
}

fn capture_before_surface_transition<C, T>(
    reveal: impl FnOnce() -> Result<bool, String>,
    capture: impl FnOnce() -> C,
    transition: impl FnOnce(C) -> Result<Option<T>, String>,
) -> Result<Option<T>, String> {
    if !reveal()? {
        return Ok(None);
    }
    transition(capture())
}

fn deliver_translator_selection<T>(
    selection: String,
    store: impl Fn(&str),
    deliver: impl FnOnce(String) -> Result<T, String>,
) -> Result<T, String> {
    store(&selection);
    match deliver(selection) {
        Ok(value) => Ok(value),
        Err(error) => {
            store("");
            Err(error)
        }
    }
}

fn trigger_hotkey_action(app: &AppHandle, action: HotkeyAction) {
    if !accept_hotkey_trigger(action) {
        return;
    }
    if matches!(action, HotkeyAction::Capture) {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = super::capture_service::request(&app, "image") {
                eprintln!("Capture failed: {error}");
                super::capture_runtime::report_capture_error(&app, &error);
            }
        });
        return;
    }
    if super::capture_service::busy(app) {
        return;
    }
    let state = app.state::<AppState>();
    let generation = if matches!(
        action,
        HotkeyAction::ScreenshotTranslation | HotkeyAction::Vision
    ) {
        let mode = if action == HotkeyAction::Vision {
            "chat"
        } else {
            "translate"
        };
        let Some(generation) = state.begin_vision_surface_action(mode) else {
            return;
        };
        generation
    } else {
        state.begin_surface_action()
    };
    if action == HotkeyAction::Translator {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            match state.with_current_surface_action(generation, || {
                if translator_is_visible(&app) {
                    hide_visible_translator_for_toggle(&app)
                } else {
                    state.cancel_active_text_commit();
                    state.set_translator_paste_target(
                        crate::platform::windows::selection::foreground_paste_target(),
                    )?;
                    state.set_translator_selection(String::new());
                    // This is the first half of the OCR clipboard-write fence.
                    // It runs behind the previous surface transition, while the
                    // capture guard below repeats it after queued F2 work drains.
                    state.cancel_reference_vision_stream();
                    state.cancel_reference_stream(ReferenceSurface::Ocr);
                    Ok(false)
                }
            }) {
                Ok(Some(true)) | Ok(None) => return,
                Ok(Some(false)) => {}
                Err(error) => {
                    eprintln!("Hotkey action {action:?} failed: {error}");
                    return;
                }
            }
            let result = capture_before_surface_transition(
                || {
                    state
                        .with_current_surface_action(generation, || {
                            let window = prepare_translator_window(&app, false)?;
                            show_without_activation(&window)?;
                            Ok(true)
                        })
                        .map(|revealed| revealed.unwrap_or(false))
                },
                || {
                    state.with_current_selection_capture(generation, || {
                        crate::platform::windows::selection::selected_text(true)
                    })
                },
                |captured| {
                    let Some(selection) = captured? else {
                        return Ok(None);
                    };
                    state.with_current_surface_action(generation, || {
                        deliver_translator_selection(
                            selection,
                            |value| state.set_translator_selection(value.to_owned()),
                            |selection| {
                                prepare_feature_surface(&app, FeatureSurface::Translator)?;
                                let window = app
                                    .get_webview_window("translator")
                                    .ok_or("Translator window is unavailable")?;
                                window
                                    .emit("screenpilot:translator-selection", selection)
                                    .map_err(|error| error.to_string())?;
                                show_and_focus(&window)
                            },
                        )
                    })
                },
            );
            if let Err(error) = result {
                let _ = state.clear_translator_paste_target();
                eprintln!("Hotkey action {action:?} failed: {error}");
            }
        });
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match action {
            HotkeyAction::Capture => Ok(()),
            HotkeyAction::Translator => Ok(()),
            HotkeyAction::Vision => {
                let selection = if app.state::<AppState>().vision_active() {
                    String::new()
                } else {
                    crate::platform::windows::selection::selected_text(false)
                };
                let state = app.state::<AppState>();
                state
                    .with_current_surface_action(generation, || {
                        state.set_vision_selection(selection);
                        show_vision(&app, "chat", generation)
                    })
                    .map(|_| ())
            }
            HotkeyAction::ScreenshotTranslation => app
                .state::<AppState>()
                .with_current_surface_action(generation, || {
                    show_vision(&app, "translate", generation)
                })
                .map(|_| ()),
            HotkeyAction::PromptOptimizer => app
                .state::<AppState>()
                .with_current_surface_action(generation, || toggle_optimizer_window(&app))
                .map(|_| ()),
        };
        if let Err(error) = result {
            eprintln!("Hotkey action {action:?} failed: {error}");
        }
    });
}

pub fn register_shortcuts(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    merge_shortcut_results(active_shortcuts(settings).into_iter().map(
        |(label, shortcut, action)| {
            (
                format!("{label} {shortcut}"),
                register_shortcut(app, shortcut, ShortcutState::Pressed, action),
            )
        },
    ))
}

fn active_shortcuts(settings: &AppSettings) -> Vec<(&'static str, &str, HotkeyAction)> {
    let mut shortcuts = vec![(
        "文本翻译",
        settings.shortcuts.translator.as_str(),
        HotkeyAction::Translator,
    )];
    if settings.vision.enabled {
        shortcuts.push((
            "Vision",
            settings.shortcuts.vision.as_str(),
            HotkeyAction::Vision,
        ));
    }
    if settings.screenshot_translation.enabled {
        shortcuts.push((
            "OCR翻译",
            settings.shortcuts.screenshot_translation.as_str(),
            HotkeyAction::ScreenshotTranslation,
        ));
    }
    if settings.prompt_optimizer.enabled {
        shortcuts.push((
            "提示词优化",
            settings.shortcuts.prompt_optimizer.as_str(),
            HotkeyAction::PromptOptimizer,
        ));
    }
    if settings.capture.enabled && !settings.capture.shortcut.is_empty() {
        shortcuts.push((
            "截图",
            settings.capture.shortcut.as_str(),
            HotkeyAction::Capture,
        ));
    }
    shortcuts
}

fn shortcut_registration_changed(previous: &AppSettings, next: &AppSettings) -> bool {
    previous.capture.enabled != next.capture.enabled
        || previous.capture.shortcut != next.capture.shortcut
        || previous.shortcuts != next.shortcuts
        || previous.vision.enabled != next.vision.enabled
        || previous.screenshot_translation.enabled != next.screenshot_translation.enabled
        || previous.prompt_optimizer.enabled != next.prompt_optimizer.enabled
}

pub fn register_changed_shortcuts(
    app: &AppHandle,
    previous: &AppSettings,
    next: &AppSettings,
) -> Result<(), String> {
    if !shortcut_registration_changed(previous, next) {
        return Ok(());
    }

    let result = register_shortcuts(app, next);
    if result.is_ok() {
        return Ok(());
    }

    let restore = register_shortcuts(app, previous);
    match (result, restore) {
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(restore_error)) => Err(format!(
            "{error}; unable to restore the previous shortcuts: {restore_error}"
        )),
        (Ok(()), _) => Ok(()),
    }
}

fn merge_shortcut_results(
    attempts: impl IntoIterator<Item = (String, Result<(), String>)>,
) -> Result<(), String> {
    let failures = attempts
        .into_iter()
        .filter_map(|(label, result)| result.err().map(|error| format!("{label}: {error}")))
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn register_shortcut(
    app: &AppHandle,
    shortcut: &str,
    trigger_state: ShortcutState,
    action: HotkeyAction,
) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state == trigger_state {
                trigger_hotkey_action(app, action);
            }
        })
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TrayLabels {
    translator: &'static str,
    vision: &'static str,
    screenshot: &'static str,
    optimizer: &'static str,
    pub settings: &'static str,
    pub restart_admin: &'static str,
    pub quit: &'static str,
}

const TRAY_SETTINGS_ACTION_ID: &str = "settings";
const TRAY_RESTART_ADMIN_ACTION_ID: &str = "restart_admin";
const TRAY_QUIT_ACTION_ID: &str = "quit";

pub(crate) fn tray_labels(language: InterfaceLanguage) -> TrayLabels {
    match language {
        InterfaceLanguage::Zh => TrayLabels {
            translator: "文本翻译",
            vision: "Vision",
            screenshot: "OCR翻译",
            optimizer: "提示词优化",
            settings: "设置",
            restart_admin: "重启（管理员）",
            quit: "退出",
        },
        InterfaceLanguage::En => TrayLabels {
            translator: "Text translation",
            vision: "Vision",
            screenshot: "OCR translation",
            optimizer: "Prompt optimization",
            settings: "Settings",
            restart_admin: "Restart (administrator)",
            quit: "Quit",
        },
    }
}

pub(crate) fn tray_feature_items(
    settings: &AppSettings,
) -> Vec<(&'static str, &'static str, &str)> {
    let labels = tray_labels(settings.language);
    let mut items = vec![(
        "translator",
        labels.translator,
        settings.shortcuts.translator.as_str(),
    )];
    if settings.vision.enabled {
        items.push(("vision", labels.vision, settings.shortcuts.vision.as_str()));
    }
    if settings.screenshot_translation.enabled {
        items.push((
            "screenshot",
            labels.screenshot,
            settings.shortcuts.screenshot_translation.as_str(),
        ));
    }
    if settings.prompt_optimizer.enabled {
        items.push((
            "optimizer",
            labels.optimizer,
            settings.shortcuts.prompt_optimizer.as_str(),
        ));
    }
    if settings.capture.enabled {
        items.push((
            "capture",
            if settings.language == InterfaceLanguage::Zh {
                "截图 / 录制 / 扫码"
            } else {
                "Capture / Record / Scan"
            },
            settings.capture.shortcut.as_str(),
        ));
    }
    items
}

pub fn create_tray(app: &AppHandle, _settings: &AppSettings) -> Result<(), String> {
    super::tray_popup::prepare(app)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ScreenPilot")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = &event
            {
                let app = tray.app_handle();
                if let Err(error) =
                    super::tray_popup::open(app, position.x as i32, position.y as i32)
                {
                    super::capture_runtime::report_capture_error(app, &error);
                }
            }
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let app = tray.app_handle();
                let _ = run_surface_action(app, || show_main(app, MainRoute::Settings));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn run_tray_action(app: &AppHandle, action: &str) -> Result<(), String> {
    if super::capture_service::busy(app) && !matches!(action, TRAY_QUIT_ACTION_ID | "pins") {
        return super::capture_service::focus(app);
    }
    match action {
        "capture" => trigger_hotkey_action(app, HotkeyAction::Capture),
        "pins" => return super::commands::toggle_pin_visibility(app),
        "translator" => {
            return run_surface_action(app, || {
                app.state::<AppState>()
                    .set_translator_selection(String::new());
                show_translator(app)
            })
        }
        "vision" => return request_vision(app, "chat"),
        "screenshot" => return request_vision(app, "translate"),
        "optimizer" => {
            return run_surface_action(app, || show_main(app, MainRoute::PromptOptimizer))
        }
        "altsnap" => {}
        TRAY_SETTINGS_ACTION_ID => {
            return run_surface_action(app, || show_main(app, MainRoute::Settings))
        }
        TRAY_RESTART_ADMIN_ACTION_ID => {
            crate::platform::windows::startup::launch_elevated_restart()?;
            app.exit(0);
        }
        TRAY_QUIT_ACTION_ID => app.exit(0),
        _ => return Err("未知托盘菜单操作".into()),
    }
    Ok(())
}

pub fn startup_window(app: &AppHandle) -> Result<(), String> {
    activate_process(app, ProcessActivation::Initial)
}

pub fn focus_second_instance(app: &AppHandle) {
    let _ = activate_process(app, ProcessActivation::Repeated);
}

pub fn update_tray(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let _ = settings;
    let tray = app.tray_by_id("main").ok_or("Tray is unavailable")?;
    super::tray_popup::refresh(app)?;
    tray.set_tooltip(Some("ScreenPilot"))
        .map_err(|error| error.to_string())
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == super::tray_popup::LABEL {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = super::tray_popup::dismiss_unfocused(window.app_handle());
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = super::tray_popup::dismiss(window.app_handle(), None);
        }
        return;
    }
    if window.label().starts_with("capture-pin-") && matches!(event, tauri::WindowEvent::Moved(_)) {
        super::capture_runtime::pin_moved(window.app_handle(), window.label());
    }
    if matches!(window.label(), "vision" | "ocr") && matches!(event, tauri::WindowEvent::Moved(_)) {
        #[cfg(target_os = "windows")]
        if !crate::application::commands::safe_drag_active(ReferenceSurface::for_window(
            window.label(),
        )) {
            reinforce_vision_topmost(window);
        }
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if window.label() == "capture"
            || window.label().starts_with("capture-pin-")
            || window.label().starts_with("capture-scan-")
        {
            let app = window.app_handle().clone();
            let label = window.label().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                if label.starts_with("capture-pin-") {
                    if let Err(error) = super::capture_runtime::forget_pin(&app, &label, None) {
                        super::capture_runtime::report_capture_error(
                            &app,
                            &format!("钉图关闭失败：{error}"),
                        );
                        return;
                    }
                }
                super::capture_runtime::close(&app, &label)
            });
            return;
        }
        if matches!(window.label(), "vision" | "ocr") {
            let surface = ReferenceSurface::for_window(window.label());
            let app = window.app_handle().clone();
            let Some(generation) = app
                .state::<AppState>()
                .reference_surface_generation(surface)
            else {
                return;
            };
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                if let Err(error) =
                    state.with_current_reference_surface(surface, generation, || {
                        crate::application::commands::close_reference_surface(&app, surface)
                    })
                {
                    eprintln!("Reference window close cleanup failed: {error}");
                }
            });
        } else {
            if matches!(window.label(), "translator" | "main") {
                if let Some(window) = window.app_handle().get_webview_window(window.label()) {
                    let close = if window.label() == "translator" {
                        close_translator_window(window)
                    } else {
                        close_main_window(window)
                    };
                    tauri::async_runtime::spawn(async move {
                        match close.await {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => eprintln!("Window close failed: {error}"),
                            Err(error) => eprintln!("Window close task failed: {error}"),
                        }
                    });
                }
                return;
            }
            let _ = window.hide();
        }
    }
}

#[cfg(target_os = "windows")]
fn reinforce_vision_topmost(window: &tauri::Window) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

fn monitor_geometry_at_point(
    app: &AppHandle,
    point: PhysicalPoint,
) -> Result<MonitorGeometry, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let right = position.x + size.width as i32;
            let bottom = position.y + size.height as i32;
            point.0 >= position.x && point.0 < right && point.1 >= position.y && point.1 < bottom
        })
        .or_else(|| monitors.first())
        .ok_or("No display is available")?;
    let position = monitor.position();
    let size = monitor.size();
    Ok((
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
        monitor.scale_factor(),
    ))
}

fn cursor_monitor_geometry(app: &AppHandle) -> Result<(PhysicalPoint, MonitorGeometry), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let point = (cursor.x.round() as i32, cursor.y.round() as i32);
    Ok((point, monitor_geometry_at_point(app, point)?))
}

pub(crate) fn physical_window_size(logical: (f64, f64), scale: f64) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (
        (logical.0 * scale).round().max(1.0) as i32,
        (logical.1 * scale).round().max(1.0) as i32,
    )
}

fn clamp_axis(start: i32, minimum: i32, maximum: i32, size: i32) -> i32 {
    if maximum - minimum <= size {
        minimum
    } else {
        start.clamp(minimum, maximum - size)
    }
}

pub(crate) fn popup_position(
    cursor: PhysicalPoint,
    monitor: (i32, i32, i32, i32),
    window: (i32, i32),
    offset: i32,
    margin: i32,
) -> (i32, i32) {
    let left = monitor.0 + margin;
    let top = monitor.1 + margin;
    let right = monitor.0 + monitor.2 - margin;
    let bottom = monitor.1 + monitor.3 - margin;
    (
        clamp_axis(cursor.0 + offset, left, right, window.0),
        clamp_axis(cursor.1 + offset, top, bottom, window.1),
    )
}

fn centered_position(
    monitor: (i32, i32, i32, i32),
    window: (i32, i32),
    margin: i32,
) -> PhysicalPoint {
    (
        clamp_axis(
            monitor.0 + (monitor.2 - window.0) / 2,
            monitor.0 + margin,
            monitor.0 + monitor.2 - margin,
            window.0,
        ),
        clamp_axis(
            monitor.1 + (monitor.3 - window.1) / 2,
            monitor.1 + margin,
            monitor.1 + monitor.3 - margin,
            window.1,
        ),
    )
}

fn translator_popup_position(app: &AppHandle) -> Result<PhysicalPosition<i32>, String> {
    popup_window_position(app, TRANSLATOR_WIDTH, TRANSLATOR_HEIGHT)
}

fn popup_window_position(
    app: &AppHandle,
    logical_width: f64,
    logical_height: f64,
) -> Result<PhysicalPosition<i32>, String> {
    // Capture the cursor once. Reading it separately for the point and the
    // monitor lets a moving pointer cross displays between calls, producing a
    // point from one display clamped against another display's bounds.
    let (cursor, monitor) = cursor_monitor_geometry(app)?;
    // Use the route's target dimensions instead of outer_size immediately
    // after set_size. The native resize can still be in flight, and the old
    // physical size is also wrong after crossing monitors with different DPI.
    let (width, height) = physical_window_size((logical_width, logical_height), monitor.4);
    let (x, y) = popup_position(
        cursor,
        (monitor.0, monitor.1, monitor.2, monitor.3),
        (width, height),
        10,
        8,
    );
    Ok(PhysicalPosition::new(x, y))
}

fn center_on_cursor_monitor(
    app: &AppHandle,
    window: &WebviewWindow,
    logical_width: f64,
    logical_height: f64,
) -> Result<(), String> {
    let (_, monitor) = cursor_monitor_geometry(app)?;
    let (width, height) = physical_window_size((logical_width, logical_height), monitor.4);
    let (x, y) = centered_position(
        (monitor.0, monitor.1, monitor.2, monitor.3),
        (width, height),
        8,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        active_shortcuts, automatic_route, capture_before_surface_transition, centered_position,
        deliver_translator_selection, hidden_surfaces_for, main_navigation_action,
        merge_shortcut_results, physical_window_size, popup_position,
        shortcut_registration_changed, tray_feature_items, tray_labels, FeatureSurface,
        HotkeyAction, MainNavigationAction, ProcessActivation, TRAY_QUIT_ACTION_ID,
        TRAY_RESTART_ADMIN_ACTION_ID, TRAY_SETTINGS_ACTION_ID,
    };
    use crate::application::state::AppState;
    use crate::domain::settings::{AppSettings, InterfaceLanguage};
    use crate::infrastructure::images::ImageStore;
    use crate::infrastructure::settings_store::SettingsStore;
    use std::cell::{Cell, RefCell};
    use tempfile::TempDir;

    #[test]
    fn reference_capture_waits_for_withdrawal_and_composition() {
        let stages = RefCell::new(Vec::new());
        let withdrawn = Cell::new(false);
        let result = super::capture_after_withdrawal(
            || {
                stages.borrow_mut().push("hide without transitions");
                withdrawn.set(true);
                Ok(())
            },
            || {
                stages.borrow_mut().push("confirm hidden");
                Ok(withdrawn.get())
            },
            || {
                stages.borrow_mut().push("compositor presented");
                Ok(())
            },
            || {
                stages.borrow_mut().push("sample screen");
                Ok("frozen bitmap")
            },
        );
        assert_eq!(result, Ok("frozen bitmap"));
        assert_eq!(
            *stages.borrow(),
            [
                "hide without transitions",
                "confirm hidden",
                "compositor presented",
                "confirm hidden",
                "sample screen",
            ]
        );
    }

    #[test]
    fn reference_capture_aborts_on_withdrawal_or_compositor_failure() {
        for failure in [
            "hide",
            "visible",
            "missing",
            "flush",
            "reshown",
            "destroyed",
        ] {
            let sampled = Cell::new(false);
            let flushed = Cell::new(false);
            let result = super::capture_after_withdrawal(
                || {
                    if failure == "hide" {
                        Err("disable transitions or hide failed".to_string())
                    } else {
                        Ok(())
                    }
                },
                || match (failure, flushed.get()) {
                    ("missing", _) | ("destroyed", true) => Err("invalid HWND".to_string()),
                    ("visible", _) | ("reshown", true) => Ok(false),
                    _ => Ok(true),
                },
                || {
                    flushed.set(true);
                    if failure == "flush" {
                        Err("DwmFlush failed".to_string())
                    } else {
                        Ok(())
                    }
                },
                || {
                    sampled.set(true);
                    Ok(())
                },
            );
            assert!(result.is_err(), "{failure}");
            assert!(!sampled.get(), "{failure}");
            assert_eq!(
                flushed.get(),
                matches!(failure, "flush" | "reshown" | "destroyed"),
                "{failure}"
            );
        }
    }

    #[test]
    fn reference_capture_without_a_peer_preserves_capture_result() {
        assert_eq!(
            super::capture_without_reference_peer(None, || Ok(42)),
            Ok(42)
        );
        assert_eq!(
            super::capture_without_reference_peer(None, || Err::<(), _>("capture failed".into())),
            Err("capture failed".to_string())
        );
    }

    #[test]
    fn reference_withdrawal_failure_keeps_both_vision_entry_sessions_restorable() {
        use crate::application::state::ReferenceSurface;
        for has_screenshot in [false, true] {
            for fail_during_flush in [false, true] {
                let (state, _directory) = state();
                let peer = ReferenceSurface::Vision;
                let capturing = ReferenceSurface::Ocr;
                let generation = state.begin_reference_surface_action(peer).unwrap();
                state.begin_reference_surface(peer, generation);
                let session = state.begin_reference_image_session(peer).unwrap();
                let image_id = if has_screenshot {
                    let image_id = state
                        .images
                        .save_temporary(&image::RgbaImage::new(2, 2))
                        .unwrap();
                    state
                        .register_reference_temporary_image(peer, session, &image_id)
                        .unwrap();
                    Some(image_id)
                } else {
                    None
                };
                assert!(state.finish_reference_capture(peer, session));
                let stream = state.begin_active_reference_stream(peer).unwrap();
                let capturing_generation = state.begin_reference_surface_action(capturing).unwrap();
                state.begin_reference_surface(capturing, capturing_generation);
                state.claim_native_freeze(capturing);
                state.suspend_reference_surface(peer);
                let failure = "withdrawal failed".to_string();
                let result = super::capture_after_withdrawal(
                    || {
                        if fail_during_flush {
                            Ok(())
                        } else {
                            Err(failure.clone())
                        }
                    },
                    || Ok(true),
                    || Err(failure.clone()),
                    || panic!("failed withdrawal must not sample the desktop"),
                );
                assert_eq!(result, Err::<(), _>(failure));
                assert!(state.release_native_freeze(capturing));
                state.cancel_reference_stream(capturing);
                state.close_reference_image_session(capturing).unwrap();
                state.release_reference_surface(capturing);
                assert_eq!(
                    state.take_suspended_reference_surface(capturing),
                    Some(peer)
                );
                assert!(state.reference_surface_active(peer));
                assert!(state.reference_stream_current(peer, stream));
                assert_eq!(state.reference_image_session(peer), Ok(session));
                if let Some(image_id) = image_id {
                    assert!(state.images.read_data_url(&image_id).is_ok());
                }
                assert!(!state.reference_surface_active(capturing));
                assert_eq!(
                    state.with_current_reference_surface(peer, generation, || Ok(())),
                    Ok(Some(()))
                );
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reference_withdrawal_barrier_uses_a_hidden_hwnd_without_activation() {
        use super::{
            capture_window_is_withdrawn, disable_capture_window_transitions, force_hide_hwnd,
        };
        use windows::core::w;
        use windows::Win32::Graphics::Dwm::DwmFlush;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetForegroundWindow, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_POPUP,
        };
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("ScreenPilot hidden withdrawal test"),
                WS_POPUP,
                -32000,
                -32000,
                10,
                10,
                None,
                None,
                None,
                None,
            )
            .expect("hidden HWND creation failed");
            let result = super::capture_after_withdrawal(
                || {
                    disable_capture_window_transitions(hwnd)?;
                    force_hide_hwnd(hwnd);
                    Ok(())
                },
                || capture_window_is_withdrawn(hwnd),
                || DwmFlush().map_err(|error| error.to_string()),
                || {
                    assert_ne!(GetForegroundWindow(), hwnd);
                    Ok(())
                },
            );
            DestroyWindow(hwnd).expect("hidden HWND cleanup failed");
            assert_eq!(result, Ok(()));
            assert!(capture_window_is_withdrawn(Default::default()).is_err());
            assert!(disable_capture_window_transitions(Default::default()).is_err());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn force_hide_withdraws_a_raw_visible_window_after_framework_hide_state() {
        use super::{force_hide_hwnd, hide_translator_with};
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetForegroundWindow, IsWindowVisible, ShowWindow,
            SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        };

        let (state, _directory) = state();
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("ScreenPilot hide state test"),
                WS_POPUP,
                -32000,
                -32000,
                10,
                10,
                None,
                None,
                None,
                None,
            )
            .expect("raw hide test window creation failed");
            let framework_visible_snapshot = IsWindowVisible(hwnd).as_bool();
            let foreground = GetForegroundWindow();
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            assert!(!framework_visible_snapshot);
            assert!(IsWindowVisible(hwnd).as_bool());

            let request = state.begin_translator_request(1).unwrap();
            let framework_hide_called = Cell::new(false);
            hide_translator_with(
                &state,
                || {
                    assert!(request.is_cancelled());
                    force_hide_hwnd(hwnd);
                },
                || {
                    framework_hide_called.set(true);
                    if framework_visible_snapshot {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    Ok(())
                },
            )
            .unwrap();

            assert!(framework_hide_called.get());
            assert!(!IsWindowVisible(hwnd).as_bool());
            assert_eq!(GetForegroundWindow(), foreground);
            let _ = DestroyWindow(hwnd);
        }
    }

    fn state() -> (AppState, TempDir) {
        let directory = TempDir::new().expect("temp dir");
        let store = SettingsStore::new(directory.path());
        let images = ImageStore::new(directory.path(), directory.path()).expect("image store");
        (
            AppState::new(
                store,
                images,
                AppSettings::default(),
                directory.path().join("webview"),
                directory.path().join("cache"),
            ),
            directory,
        )
    }

    #[test]
    fn keeps_initial_and_repeated_process_activation_in_the_tray() {
        assert_eq!(automatic_route(ProcessActivation::Initial), None);
        assert_eq!(automatic_route(ProcessActivation::Repeated), None);
    }

    #[test]
    fn hidden_main_routes_always_restore_their_popup_geometry_before_reveal() {
        assert_eq!(
            main_navigation_action(
                super::MainRoute::Settings,
                super::MainRoute::Settings,
                false,
            ),
            MainNavigationAction::ApplyDirectly
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::Settings,
                super::MainRoute::PromptOptimizer,
                false,
            ),
            MainNavigationAction::ApplyDirectly
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::PromptOptimizer,
                super::MainRoute::PromptOptimizer,
                false,
            ),
            MainNavigationAction::ApplyDirectly
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::PromptOptimizer,
                super::MainRoute::Settings,
                false,
            ),
            MainNavigationAction::ApplyDirectly
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::Settings,
                super::MainRoute::PromptOptimizer,
                true,
            ),
            MainNavigationAction::AskSettingsGuard
        );
        assert_eq!(
            main_navigation_action(super::MainRoute::Settings, super::MainRoute::Settings, true,),
            MainNavigationAction::FocusCurrent
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::PromptOptimizer,
                super::MainRoute::PromptOptimizer,
                true,
            ),
            MainNavigationAction::FocusCurrent
        );
        assert_eq!(
            main_navigation_action(
                super::MainRoute::PromptOptimizer,
                super::MainRoute::Settings,
                true,
            ),
            MainNavigationAction::AskSettingsGuard
        );
    }

    #[test]
    fn isolates_feature_surfaces_during_window_transitions() {
        assert_eq!(
            hidden_surfaces_for(FeatureSurface::Vision),
            &[FeatureSurface::Main, FeatureSurface::Translator]
        );
        assert_eq!(
            hidden_surfaces_for(FeatureSurface::Translator),
            &[
                FeatureSurface::Main,
                FeatureSurface::Vision,
                FeatureSurface::Ocr
            ]
        );
    }

    #[test]
    fn keeps_shortcut_debounce_scoped_by_action() {
        assert_eq!(HotkeyAction::Translator.scope(), "translator");
        assert_eq!(HotkeyAction::Vision.scope(), "vision");
        assert_eq!(
            HotkeyAction::ScreenshotTranslation.scope(),
            "screenshot_translation"
        );
        assert_eq!(HotkeyAction::PromptOptimizer.scope(), "prompt_optimizer");
    }

    #[test]
    fn translator_hotkey_reveals_before_capture_and_defers_the_surface_transition() {
        let stages = RefCell::new(Vec::new());

        let result = capture_before_surface_transition(
            || {
                stages.borrow_mut().push("reveal without activation");
                Ok(true)
            },
            || {
                stages.borrow_mut().push("capture");
                "selected text".to_string()
            },
            |selection| {
                stages.borrow_mut().push("transition");
                Ok(Some(selection))
            },
        );

        assert_eq!(result, Ok(Some("selected text".to_string())));
        assert_eq!(
            *stages.borrow(),
            ["reveal without activation", "capture", "transition"]
        );
    }

    #[test]
    fn optimizer_hotkey_toggles_hidden_visible_hidden_visible_and_cancels_pending_work() {
        let (state, _directory) = state();
        let visible = Cell::new(false);
        let actions = RefCell::new(Vec::new());
        assert_eq!(state.main_route(), Ok(super::MainRoute::Settings));
        let toggle = || {
            super::toggle_optimizer_with(
                &state,
                visible.get(),
                || {
                    actions.borrow_mut().push("hide");
                    visible.set(false);
                    Ok(())
                },
                || {
                    actions.borrow_mut().push("reset and show");
                    state.set_main_route(super::MainRoute::PromptOptimizer)?;
                    visible.set(true);
                    Ok(())
                },
            )
        };

        let opening = state.begin_surface_action();
        assert_eq!(
            state.with_current_surface_action(opening, toggle),
            Ok(Some(()))
        );
        assert!(visible.get());
        let request = state.begin_optimizer_request(100).unwrap();
        let closing = state.begin_surface_action();
        assert_eq!(
            state.with_current_surface_action(closing, toggle),
            Ok(Some(()))
        );
        assert!(!visible.get());
        assert!(request.is_cancelled());
        assert!(!state.optimizer_request_current(100));
        assert_eq!(state.main_route(), Ok(super::MainRoute::PromptOptimizer));
        assert_eq!(
            state.with_current_surface_action(opening, || {
                panic!("queued entrance must not reopen the closed optimizer")
            }),
            Ok::<Option<()>, String>(None)
        );

        let reopened = state.begin_surface_action();
        assert_eq!(
            state.with_current_surface_action(reopened, toggle),
            Ok(Some(()))
        );
        let current_request = state.begin_optimizer_request(101).unwrap();
        assert_eq!(state.with_current_surface_action(closing, toggle), Ok(None));
        assert!(visible.get());
        assert!(!current_request.is_cancelled());
        assert_eq!(
            *actions.borrow(),
            ["reset and show", "hide", "reset and show"]
        );
    }

    #[test]
    fn optimizer_hotkey_switches_visible_settings_instead_of_hiding_them() {
        let (state, _directory) = state();
        let shows = Cell::new(0);
        for _ in 0..2 {
            state.set_main_route(super::MainRoute::Settings).unwrap();
            super::toggle_optimizer_with(
                &state,
                true,
                || panic!("visible settings must switch to optimizer, not close"),
                || {
                    shows.set(shows.get() + 1);
                    state.set_main_route(super::MainRoute::PromptOptimizer)
                },
            )
            .unwrap();
            assert_eq!(state.main_route(), Ok(super::MainRoute::PromptOptimizer));
        }
        assert_eq!(shows.get(), 2);
    }

    #[test]
    fn optimizer_hotkey_reopens_a_hidden_optimizer_after_explicit_close() {
        let (state, _directory) = state();
        state
            .set_main_route(super::MainRoute::PromptOptimizer)
            .unwrap();
        let pending_open = state.begin_surface_action();
        let request = state.begin_optimizer_request(100).unwrap();
        let close = state.begin_surface_action();
        state
            .with_current_surface_action(close, || {
                state.cancel_active_optimizer_request();
                Ok(())
            })
            .unwrap();
        assert!(request.is_cancelled());
        assert_eq!(
            state.with_current_surface_action(pending_open, || {
                panic!("explicit close must invalidate a queued open")
            }),
            Ok::<Option<()>, String>(None)
        );
        let reopened = state.begin_surface_action();
        let shows = Cell::new(0);
        assert_eq!(
            state.with_current_surface_action(reopened, || {
                super::toggle_optimizer_with(
                    &state,
                    false,
                    || panic!("hidden optimizer must reopen"),
                    || {
                        shows.set(shows.get() + 1);
                        Ok(())
                    },
                )
            }),
            Ok(Some(()))
        );
        assert_eq!(shows.get(), 1);
        assert!(state.begin_optimizer_request(101).is_some());
    }

    #[test]
    fn disabled_optimizer_hotkey_neither_shows_nor_hides_the_main_window() {
        let (state, _directory) = state();
        let mut settings = state.current().unwrap();
        settings.prompt_optimizer.enabled = false;
        state.replace(&settings).unwrap();
        for route in [
            super::MainRoute::Settings,
            super::MainRoute::PromptOptimizer,
        ] {
            state.set_main_route(route).unwrap();
            for visible in [false, true] {
                assert_eq!(
                    super::toggle_optimizer_with(
                        &state,
                        visible,
                        || panic!("disabled hotkey must not hide a window"),
                        || panic!("disabled hotkey must not show a window"),
                    ),
                    Err("Prompt optimizer is disabled in settings".to_string())
                );
                assert_eq!(state.main_route(), Ok(route));
            }
        }
    }

    #[test]
    fn optimizer_toggle_close_cancels_even_if_hiding_fails_and_does_not_reset() {
        let (state, _directory) = state();
        state
            .set_main_route(super::MainRoute::PromptOptimizer)
            .unwrap();
        let request = state.begin_optimizer_request(100).unwrap();
        assert_eq!(
            super::toggle_optimizer_with(
                &state,
                true,
                || Err("hide failed".to_string()),
                || panic!("toggle close must never reset the optimizer"),
            ),
            Err("hide failed".to_string())
        );
        assert!(request.is_cancelled());
        assert_eq!(state.main_route(), Ok(super::MainRoute::PromptOptimizer));
    }

    #[test]
    fn a_cancelled_or_failed_translator_reveal_never_captures_external_selection() {
        for reveal in [Ok(false), Err("window unavailable".to_string())] {
            let result = capture_before_surface_transition(
                || reveal.clone(),
                || panic!("capture must not start"),
                |_: String| Ok(Some("transition must not start")),
            );
            assert_eq!(result, reveal.map(|_| None));
        }
    }

    #[test]
    fn failed_translator_delivery_clears_the_stored_selection() {
        let stored = RefCell::new(String::new());

        let result = deliver_translator_selection(
            "selected text".to_string(),
            |value| value.clone_into(&mut stored.borrow_mut()),
            |_| Err::<(), _>("window creation failed".to_string()),
        );

        assert_eq!(result, Err("window creation failed".to_string()));
        assert_eq!(*stored.borrow(), "");
    }

    #[test]
    fn a_newer_surface_intent_discards_an_older_translator_capture() {
        let (state, _directory) = state();
        let captured_for = state.begin_surface_action();
        let newer_intent = state.begin_surface_action();
        let delivered = Cell::new(false);

        assert_eq!(
            state.with_current_surface_action(captured_for, || {
                delivered.set(true);
                Ok::<_, String>(())
            }),
            Ok(None)
        );
        assert!(!delivered.get());
        assert!(state.surface_action_is_current(newer_intent));
    }

    #[test]
    fn translator_toggle_then_explicit_close_discard_captures_without_blocking_reopen() {
        let (state, _directory) = state();
        let native_visible = Cell::new(false);
        let framework_visible = Cell::new(false);
        let deliveries = Cell::new(0);

        for _ in 0..2 {
            let capture_generation = state.begin_surface_action();
            let request = state.begin_translator_request(capture_generation).unwrap();
            state
                .with_current_surface_action(capture_generation, || {
                    native_visible.set(true);
                    Ok(())
                })
                .unwrap();
            assert!(!framework_visible.get());
            let close_generation = state.begin_surface_action();
            assert_eq!(
                state.with_current_surface_action(close_generation, || {
                    super::hide_translator_with(
                        &state,
                        || native_visible.set(false),
                        || {
                            if framework_visible.replace(false) {
                                native_visible.set(false);
                            }
                            Ok(())
                        },
                    )
                }),
                Ok(Some(()))
            );
            assert!(request.is_cancelled());
            assert_eq!(
                state.with_current_surface_action(capture_generation, || {
                    deliveries.set(deliveries.get() + 1);
                    native_visible.set(true);
                    state.set_translator_selection("late selection".to_string());
                    Ok(())
                }),
                Ok(None)
            );
            assert!(!native_visible.get());
            assert_eq!(state.take_translator_selection(), "");
        }

        let reopened = state.begin_surface_action();
        assert_eq!(
            state.with_current_surface_action(reopened, || {
                native_visible.set(true);
                state.set_translator_selection("new selection".to_string());
                Ok(())
            }),
            Ok(Some(()))
        );
        assert!(native_visible.get());
        assert_eq!(state.take_translator_selection(), "new selection");
        assert_eq!(deliveries.get(), 0);
    }

    #[test]
    fn translator_close_follows_an_already_admitted_reveal() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        let (state, _directory) = state();
        let state = Arc::new(state);
        let native_visible = Arc::new(AtomicBool::new(false));
        let reveal_generation = state.begin_surface_action();
        let (admitted, admission) = channel();
        let (finish, finish_reveal) = channel();
        let revealing = {
            let state = Arc::clone(&state);
            let native_visible = Arc::clone(&native_visible);
            std::thread::spawn(move || {
                state.with_current_surface_action(reveal_generation, || {
                    admitted.send(()).unwrap();
                    finish_reveal
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    native_visible.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        admission
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let close_generation = state.begin_surface_action();
        let closing = {
            let state = Arc::clone(&state);
            let native_visible = Arc::clone(&native_visible);
            std::thread::spawn(move || {
                state.with_current_surface_action(close_generation, || {
                    assert!(native_visible.load(Ordering::SeqCst));
                    super::hide_translator_with(
                        &state,
                        || native_visible.store(false, Ordering::SeqCst),
                        || Ok(()),
                    )
                })
            })
        };
        finish.send(()).unwrap();
        assert_eq!(revealing.join().unwrap(), Ok(Some(())));
        assert_eq!(closing.join().unwrap(), Ok(Some(())));
        assert!(!native_visible.load(Ordering::SeqCst));
        assert_eq!(
            state.with_current_surface_action(reveal_generation, || {
                panic!("late selection must not refocus or reopen the translator")
            }),
            Ok::<Option<()>, String>(None)
        );
    }

    #[test]
    fn translator_native_hide_and_cancellation_survive_framework_hide_failure() {
        let (state, _directory) = state();
        let request = state.begin_translator_request(1).unwrap();
        let native_visible = Cell::new(true);
        assert_eq!(
            super::hide_translator_with(
                &state,
                || native_visible.set(false),
                || Err("framework hide failed".to_string()),
            ),
            Err("framework hide failed".to_string())
        );
        assert!(!native_visible.get());
        assert!(request.is_cancelled());
    }

    #[test]
    fn vision_cleanup_neither_overrides_nor_invalidates_a_translator_hotkey() {
        let (state, _directory) = state();
        let vision_generation = state.begin_surface_action();
        assert!(!state.begin_vision(vision_generation));
        let translator_hotkey = state.begin_surface_action();
        let cleanup_ran = Cell::new(false);

        assert_eq!(
            state.with_current_surface_action(
                state.vision_surface_generation().expect("vision token"),
                || {
                    cleanup_ran.set(true);
                    Ok::<_, String>(())
                }
            ),
            Ok(None)
        );
        assert!(!cleanup_ran.get());
        assert!(state.surface_action_is_current(translator_hotkey));
        assert_eq!(
            state.with_current_surface_action(translator_hotkey, || { Ok::<_, String>(()) }),
            Ok(Some(()))
        );
    }

    #[test]
    fn preserves_available_shortcuts_and_reports_every_conflict() {
        let result = merge_shortcut_results([
            ("文本翻译 F2".into(), Ok(())),
            ("Vision F3".into(), Err("occupied".into())),
            ("OCR翻译 F4".into(), Ok(())),
            ("提示词优化 Control+Alt+P".into(), Err("occupied".into())),
        ]);
        let error = result.expect_err("conflicts must remain visible");
        assert!(error.contains("Vision F3: occupied"));
        assert!(error.contains("提示词优化 Control+Alt+P: occupied"));
    }

    #[test]
    fn filters_shortcuts_and_tray_entries_by_feature_enablement() {
        let mut settings = AppSettings::default();
        settings.capture.enabled = false;
        settings.vision.enabled = false;
        settings.screenshot_translation.enabled = false;
        settings.prompt_optimizer.enabled = false;

        assert_eq!(
            active_shortcuts(&settings)
                .into_iter()
                .map(|(_, shortcut, action)| (shortcut, action))
                .collect::<Vec<_>>(),
            vec![(
                settings.shortcuts.translator.as_str(),
                HotkeyAction::Translator
            )]
        );
        assert_eq!(
            tray_feature_items(&settings),
            vec![(
                "translator",
                "文本翻译",
                settings.shortcuts.translator.as_str()
            )]
        );
    }

    #[test]
    fn localizes_tray_feature_and_fixed_menu_labels_without_changing_action_ids() {
        let zh = AppSettings::default();
        assert_eq!(
            tray_feature_items(&zh),
            vec![
                ("translator", "文本翻译", "F2"),
                ("vision", "Vision", "F3"),
                ("screenshot", "OCR翻译", "F4"),
                ("optimizer", "提示词优化", "Control+Alt+P"),
                ("capture", "截图 / 录制 / 扫码", "Control+Alt+S"),
            ]
        );
        let mut en = zh.clone();
        en.language = InterfaceLanguage::En;
        assert_eq!(
            tray_feature_items(&en),
            vec![
                ("translator", "Text translation", "F2"),
                ("vision", "Vision", "F3"),
                ("screenshot", "OCR translation", "F4"),
                ("optimizer", "Prompt optimization", "Control+Alt+P"),
                ("capture", "Capture / Record / Scan", "Control+Alt+S"),
            ]
        );
        assert_eq!(tray_labels(InterfaceLanguage::Zh).settings, "设置");
        assert_eq!(
            tray_labels(InterfaceLanguage::Zh).restart_admin,
            "重启（管理员）"
        );
        assert_eq!(tray_labels(InterfaceLanguage::Zh).quit, "退出");
        assert_eq!(tray_labels(InterfaceLanguage::En).settings, "Settings");
        assert_eq!(
            tray_labels(InterfaceLanguage::En).restart_admin,
            "Restart (administrator)"
        );
        assert_eq!(tray_labels(InterfaceLanguage::En).quit, "Quit");
        assert_eq!(
            [
                TRAY_SETTINGS_ACTION_ID,
                TRAY_RESTART_ADMIN_ACTION_ID,
                TRAY_QUIT_ACTION_ID,
            ],
            ["settings", "restart_admin", "quit"]
        );
    }

    #[test]
    fn enablement_changes_require_shortcut_reregistration() {
        let previous = AppSettings::default();
        let mut next = previous.clone();
        assert!(!shortcut_registration_changed(&previous, &next));
        next.vision.enabled = false;
        assert!(shortcut_registration_changed(&previous, &next));
    }

    #[test]
    fn keeps_initial_popup_inside_positive_and_negative_monitor_bounds() {
        assert_eq!(
            popup_position((1918, 1078), (0, 0, 1920, 1080), (680, 520), 10, 8),
            (1232, 552)
        );
        assert_eq!(
            popup_position((-1, -1), (-1920, -1080, 1920, 1080), (680, 520), 10, 8),
            (-688, -528)
        );
    }

    #[test]
    fn centers_settings_on_positive_negative_and_scaled_monitors() {
        assert_eq!(
            centered_position((0, 0, 1920, 1080), (760, 620), 8),
            (580, 230)
        );
        assert_eq!(
            centered_position((-2560, -360, 2560, 1440), (760, 620), 8),
            (-1660, 50)
        );
        assert_eq!(physical_window_size((760.0, 620.0), 1.5), (1140, 930));
        assert_eq!(
            centered_position((1920, 0, 2560, 1440), (1140, 930), 8),
            (2630, 255)
        );
    }

    #[test]
    fn invalid_monitor_scale_falls_back_to_one() {
        assert_eq!(physical_window_size((680.0, 450.0), f64::NAN), (680, 450));
        assert_eq!(physical_window_size((680.0, 450.0), 0.0), (680, 450));
    }

    #[test]
    fn anchors_oversized_popup_to_the_monitor_margin() {
        assert_eq!(
            popup_position((50, 50), (0, 0, 600, 400), (680, 520), 10, 8),
            (8, 8)
        );
    }
}
