use crate::application::state::AppState;
use crate::domain::settings::AppSettings;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const TRANSLATOR_WIDTH: f64 = 680.0;
const TRANSLATOR_HEIGHT: f64 = 400.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FeatureSurface {
    Main,
    Translator,
    Vision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum HotkeyAction {
    Translator,
    Vision,
    ScreenshotTranslation,
    PromptOptimizer,
}

impl HotkeyAction {
    fn scope(self) -> &'static str {
        match self {
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
        FeatureSurface::Main => &[FeatureSurface::Translator, FeatureSurface::Vision],
        FeatureSurface::Translator => &[FeatureSurface::Main, FeatureSurface::Vision],
        FeatureSurface::Vision => &[FeatureSurface::Main, FeatureSurface::Translator],
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
                    if target == FeatureSurface::Vision {
                        window.destroy().map_err(|error| error.to_string())?;
                        wait_for_translator_withdrawn(&window);
                    }
                }
            }
            FeatureSurface::Vision => {
                crate::application::commands::close_reference_vision_surface(app)?;
            }
        }
    }
    if target == FeatureSurface::Vision {
        flush_windows_compositor();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn flush_windows_compositor() {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    let _ = unsafe { DwmFlush() };
}

#[cfg(not(target_os = "windows"))]
fn flush_windows_compositor() {}

fn hide_translator_surface(window: &WebviewWindow) -> Result<(), String> {
    force_hide_window(window);
    window.hide().map_err(|error| error.to_string())?;
    wait_for_translator_withdrawn(window);
    Ok(())
}

#[cfg(target_os = "windows")]
fn force_hide_window(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = window.hwnd() {
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
    }
}

#[cfg(not(target_os = "windows"))]
fn force_hide_window(_window: &WebviewWindow) {}

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
pub enum MainRoute {
    Settings,
    PromptOptimizer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessActivation {
    Initial,
    Repeated,
}

fn automatic_route(_activation: ProcessActivation) -> Option<MainRoute> {
    None
}

fn activate_process(app: &AppHandle, activation: ProcessActivation) -> Result<(), String> {
    match automatic_route(activation) {
        Some(route) => show_main(app, route),
        None => Ok(()),
    }
}

impl MainRoute {
    fn name(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::PromptOptimizer => "prompt-optimizer",
        }
    }

    fn size(self) -> (f64, f64) {
        match self {
            Self::Settings => (760.0, 620.0),
            Self::PromptOptimizer => (680.0, 450.0),
        }
    }
}

pub fn show_main(app: &AppHandle, route: MainRoute) -> Result<(), String> {
    prepare_feature_surface(app, FeatureSurface::Main)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window
        .emit("screenpilot:reset", route.name())
        .map_err(|error| error.to_string())?;
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
        MainRoute::Settings => center_on_cursor_monitor(app, &window)?,
        MainRoute::PromptOptimizer => {
            let position = popup_window_position(app, &window, width, height)?;
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

pub fn show_translator(app: &AppHandle) -> Result<(), String> {
    show_translator_window(app, true, true)
}

fn show_translator_window(
    app: &AppHandle,
    activate: bool,
    reset_existing: bool,
) -> Result<(), String> {
    prepare_feature_surface(app, FeatureSurface::Translator)?;
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
    let position = translator_popup_position(app, &window)?;
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window
        .emit("screenpilot:route", "translator")
        .map_err(|error| error.to_string())?;
    if activate {
        show_and_focus(&window)
    } else {
        show_without_activation(&window)
    }
}

#[cfg(target_os = "windows")]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
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
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
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

pub fn show_vision(app: &AppHandle, mode: &'static str) -> Result<(), String> {
    prepare_feature_surface(app, FeatureSurface::Vision)?;
    crate::application::commands::open_reference_vision(app, mode)
}

fn hide_visible_translator_for_toggle(app: &AppHandle) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("translator") else {
        return Ok(false);
    };
    if !window.is_visible().unwrap_or(false) {
        return Ok(false);
    }
    window.hide().map_err(|error| error.to_string())?;
    normalize_translator_window(&window)?;
    Ok(true)
}

fn trigger_hotkey_action(app: &AppHandle, action: HotkeyAction) {
    if !accept_hotkey_trigger(action) {
        return;
    }
    let state = app.state::<AppState>();
    let generation = state.begin_surface_action();
    if action == HotkeyAction::Translator {
        match state
            .with_current_surface_action(generation, || hide_visible_translator_for_toggle(app))
        {
            Ok(Some(true)) | Ok(None) => return,
            Ok(Some(false)) => {}
            Err(error) => {
                eprintln!("Hotkey action {action:?} failed: {error}");
                return;
            }
        }
    }
    if action == HotkeyAction::Translator {
        state.set_translator_selection(String::new());
        let shown = state
            .with_current_surface_action(generation, || show_translator_window(app, false, false));
        match shown {
            Ok(Some(())) => {}
            Ok(None) => return,
            Err(error) => {
                eprintln!("Hotkey action {action:?} failed: {error}");
                return;
            }
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let selection = crate::platform::windows::selection::selected_text(true);
            let state = app.state::<AppState>();
            let result = state.with_current_surface_action(generation, || {
                state.set_translator_selection(selection.clone());
                let window = app
                    .get_webview_window("translator")
                    .ok_or("Translator window is unavailable")?;
                window
                    .emit("screenpilot:translator-selection", selection)
                    .map_err(|error| error.to_string())?;
                show_and_focus(&window)
            });
            if let Err(error) = result {
                eprintln!("Hotkey action {action:?} failed: {error}");
            }
        });
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match action {
            HotkeyAction::Translator => Ok(()),
            HotkeyAction::Vision => {
                let selection = crate::platform::windows::selection::selected_text(false);
                let state = app.state::<AppState>();
                state
                    .with_current_surface_action(generation, || {
                        state.set_vision_selection(selection);
                        show_vision(&app, "chat")
                    })
                    .map(|_| ())
            }
            HotkeyAction::ScreenshotTranslation => app
                .state::<AppState>()
                .with_current_surface_action(generation, || show_vision(&app, "translate"))
                .map(|_| ()),
            HotkeyAction::PromptOptimizer => app
                .state::<AppState>()
                .with_current_surface_action(generation, || {
                    show_main(&app, MainRoute::PromptOptimizer)
                })
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
    merge_shortcut_results([
        (
            format!("文本翻译 {}", settings.shortcuts.translator),
            register_shortcut(
                app,
                &settings.shortcuts.translator,
                ShortcutState::Pressed,
                HotkeyAction::Translator,
            ),
        ),
        (
            format!("Vision {}", settings.shortcuts.vision),
            register_shortcut(
                app,
                &settings.shortcuts.vision,
                ShortcutState::Pressed,
                HotkeyAction::Vision,
            ),
        ),
        (
            format!("截图翻译 {}", settings.shortcuts.screenshot_translation),
            register_shortcut(
                app,
                &settings.shortcuts.screenshot_translation,
                ShortcutState::Pressed,
                HotkeyAction::ScreenshotTranslation,
            ),
        ),
        (
            format!("提示词优化 {}", settings.shortcuts.prompt_optimizer),
            register_shortcut(
                app,
                &settings.shortcuts.prompt_optimizer,
                ShortcutState::Pressed,
                HotkeyAction::PromptOptimizer,
            ),
        ),
    ])
}

pub fn register_changed_shortcuts(
    app: &AppHandle,
    previous: &AppSettings,
    next: &AppSettings,
) -> Result<(), String> {
    let changes = [
        (
            "文本翻译",
            &previous.shortcuts.translator,
            &next.shortcuts.translator,
            ShortcutState::Pressed,
            HotkeyAction::Translator,
        ),
        (
            "Vision",
            &previous.shortcuts.vision,
            &next.shortcuts.vision,
            ShortcutState::Pressed,
            HotkeyAction::Vision,
        ),
        (
            "截图翻译",
            &previous.shortcuts.screenshot_translation,
            &next.shortcuts.screenshot_translation,
            ShortcutState::Pressed,
            HotkeyAction::ScreenshotTranslation,
        ),
        (
            "提示词优化",
            &previous.shortcuts.prompt_optimizer,
            &next.shortcuts.prompt_optimizer,
            ShortcutState::Pressed,
            HotkeyAction::PromptOptimizer,
        ),
    ];
    let changed = changes.iter().any(|(_, old, new, _, _)| old != new);
    if !changed {
        return Ok(());
    }

    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("Unable to release current shortcuts: {error}"))?;

    let result = merge_shortcut_results(changes.map(|(label, _, new, state, action)| {
        (
            format!("{label} {new}"),
            register_shortcut(app, new, state, action),
        )
    }));
    if result.is_ok() {
        return Ok(());
    }

    let _ = app.global_shortcut().unregister_all();
    let restore = merge_shortcut_results(changes.map(|(label, old, _, state, action)| {
        (
            format!("{label} {old}"),
            register_shortcut(app, old, state, action),
        )
    }));
    match (result, restore) {
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(restore_error)) => Err(format!(
            "{error}; unable to restore the previous shortcuts: {restore_error}"
        )),
        (Ok(()), _) => Ok(()),
    }
}

fn merge_shortcut_results<const N: usize>(
    attempts: [(String, Result<(), String>); N],
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

pub fn create_tray(app: &AppHandle) -> Result<(), String> {
    let menu = MenuBuilder::new(app)
        .text("translator", "文本翻译")
        .text("vision", "Vision")
        .text("screenshot", "截图翻译")
        .text("optimizer", "提示词优化")
        .separator()
        .text("settings", "设置")
        .separator()
        .text("restart_admin", "重启（管理员）")
        .text("quit", "退出")
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("ScreenPilot")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let app = tray.app_handle();
                app.state::<AppState>().begin_surface_action();
                let _ = show_main(app, MainRoute::Settings);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "translator" => {
                let state = app.state::<AppState>();
                state.begin_surface_action();
                state.set_translator_selection(String::new());
                let _ = show_translator(app);
            }
            "vision" => {
                app.state::<AppState>().begin_surface_action();
                let _ = show_vision(app, "chat");
            }
            "screenshot" => {
                app.state::<AppState>().begin_surface_action();
                let _ = show_vision(app, "translate");
            }
            "optimizer" => {
                app.state::<AppState>().begin_surface_action();
                let _ = show_main(app, MainRoute::PromptOptimizer);
            }
            "settings" => {
                app.state::<AppState>().begin_surface_action();
                let _ = show_main(app, MainRoute::Settings);
            }
            "restart_admin" => match crate::platform::windows::startup::launch_elevated_restart() {
                Ok(()) => app.exit(0),
                Err(error) => {
                    eprintln!("Administrator restart failed: {error}");
                }
            },
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn startup_window(app: &AppHandle) -> Result<(), String> {
    activate_process(app, ProcessActivation::Initial)
}

pub fn focus_second_instance(app: &AppHandle) {
    let _ = activate_process(app, ProcessActivation::Repeated);
}

pub fn update_tray(app: &AppHandle) -> Result<(), String> {
    app.tray_by_id("main")
        .ok_or("Tray is unavailable")?
        .set_tooltip(Some("ScreenPilot"))
        .map_err(|error| error.to_string())
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "vision" && matches!(event, tauri::WindowEvent::Moved(_)) {
        #[cfg(target_os = "windows")]
        reinforce_vision_topmost(window);
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if window.label() == "vision" {
            window
                .app_handle()
                .state::<AppState>()
                .begin_surface_action();
            if let Err(error) =
                crate::application::commands::close_reference_vision_surface(window.app_handle())
            {
                eprintln!("Vision close cleanup failed: {error}");
            }
        } else {
            if window.label() == "translator" {
                window
                    .app_handle()
                    .state::<AppState>()
                    .begin_surface_action();
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

fn monitor_geometry_at_cursor(app: &AppHandle) -> Result<(i32, i32, i32, i32, f64), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
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
            (cursor.x as i32) >= position.x
                && (cursor.x as i32) < right
                && (cursor.y as i32) >= position.y
                && (cursor.y as i32) < bottom
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

fn clamp_axis(start: i32, minimum: i32, maximum: i32, size: i32) -> i32 {
    if maximum - minimum <= size {
        minimum
    } else {
        start.clamp(minimum, maximum - size)
    }
}

fn popup_position(
    cursor: (i32, i32),
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

fn translator_popup_position(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<PhysicalPosition<i32>, String> {
    popup_window_position(app, window, TRANSLATOR_WIDTH, TRANSLATOR_HEIGHT)
}

fn popup_window_position(
    app: &AppHandle,
    window: &WebviewWindow,
    fallback_width: f64,
    fallback_height: f64,
) -> Result<PhysicalPosition<i32>, String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let monitor = monitor_geometry_at_cursor(app)?;
    let size = window.outer_size().ok();
    let scale = if monitor.4.is_finite() && monitor.4 > 0.0 {
        monitor.4
    } else {
        1.0
    };
    let width = size
        .map(|value| value.width as i32)
        .unwrap_or_else(|| (fallback_width * scale).round() as i32)
        .max(1);
    let height = size
        .map(|value| value.height as i32)
        .unwrap_or_else(|| (fallback_height * scale).round() as i32)
        .max(1);
    let (x, y) = popup_position(
        (cursor.x.round() as i32, cursor.y.round() as i32),
        (monitor.0, monitor.1, monitor.2, monitor.3),
        (width, height),
        10,
        8,
    );
    Ok(PhysicalPosition::new(x, y))
}

fn center_on_cursor_monitor(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = monitor_geometry_at_cursor(app)?;
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let width = window_size.width as i32;
    let height = window_size.height as i32;
    let x = clamp_axis(
        monitor.0 + (monitor.2 - width) / 2,
        monitor.0 + 8,
        monitor.0 + monitor.2 - 8,
        width,
    );
    let y = clamp_axis(
        monitor.1 + (monitor.3 - height) / 2,
        monitor.1 + 8,
        monitor.1 + monitor.3 - 8,
        height,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_route, hidden_surfaces_for, merge_shortcut_results, popup_position,
        FeatureSurface, HotkeyAction, ProcessActivation,
    };

    #[test]
    fn keeps_initial_and_repeated_process_activation_in_the_tray() {
        assert_eq!(automatic_route(ProcessActivation::Initial), None);
        assert_eq!(automatic_route(ProcessActivation::Repeated), None);
    }

    #[test]
    fn isolates_feature_surfaces_during_window_transitions() {
        assert_eq!(
            hidden_surfaces_for(FeatureSurface::Vision),
            &[FeatureSurface::Main, FeatureSurface::Translator]
        );
        assert_eq!(
            hidden_surfaces_for(FeatureSurface::Translator),
            &[FeatureSurface::Main, FeatureSurface::Vision]
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
    fn preserves_available_shortcuts_and_reports_every_conflict() {
        let result = merge_shortcut_results([
            ("文本翻译 F2".into(), Ok(())),
            ("Vision F3".into(), Err("occupied".into())),
            ("截图翻译 F4".into(), Ok(())),
            ("提示词优化 Control+Alt+P".into(), Err("occupied".into())),
        ]);
        let error = result.expect_err("conflicts must remain visible");
        assert!(error.contains("Vision F3: occupied"));
        assert!(error.contains("提示词优化 Control+Alt+P: occupied"));
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
    fn anchors_oversized_popup_to_the_monitor_margin() {
        assert_eq!(
            popup_position((50, 50), (0, 0, 600, 400), (680, 520), 10, 8),
            (8, 8)
        );
    }
}
