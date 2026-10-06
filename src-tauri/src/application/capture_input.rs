//! Low-level input state machine hosted by ScreenPilot.
use super::{capture_native::Rect, capture_runtime as capture, state::AppState};
use inputhub::{
    engine::{Button, Event, Modifiers},
    hooks::HookThread,
};
use serde_json::json;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

pub fn start(app: AppHandle) {
    if let Ok(rect) = super::capture_native::desktop_rect() {
        let _ = WebviewWindowBuilder::new(
            &app,
            "capture-quick",
            WebviewUrl::App("index.html?route=capture&window=capture-quick".into()),
        )
        .title("ScreenPilot 拖选")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .content_protected(true)
        .data_directory(app.state::<AppState>().webview_data_directory.clone())
        .build();
        if let Some(window) = app.get_webview_window("capture-quick") {
            if let Ok(hwnd) = window.hwnd() {
                let _ = super::lifecycle::disable_capture_window_transitions(hwnd);
            }
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
            let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
            let _ = window.set_ignore_cursor_events(true);
        }
    }
    std::thread::spawn(move || {
        let Ok((mut hook, receiver)) = HookThread::start() else {
            capture::report_capture_error(&app, "全局拖选钩子启动失败");
            return;
        };
        let mut previous = None;
        let mut bindings = Vec::new();
        let mut gesture: Option<(u64, i32, i32, String)> = None;
        let mut watching_wheel = false;
        let mut watching_shift = false;
        let mut shift_pressed = false;
        while !capture::stopped(&app) {
            let (watch_wheel, watch_shift) = app
                .state::<capture::CaptureManager>()
                .sessions
                .lock()
                .map(|sessions| {
                    (
                        sessions.values().any(|s| {
                            s.scroll.is_some()
                                || s.recorder.as_ref().is_some_and(|r| r.is_recording())
                        }),
                        sessions
                            .values()
                            .any(|s| s.scroll.is_some() && s.horizontal),
                    )
                })
                .unwrap_or((false, false));
            if watch_wheel != watching_wheel {
                hook.shared().with_engine(|engine, _| {
                    if watch_wheel {
                        engine.watch_wheel("capture-recording", None);
                    } else {
                        engine.unwatch_wheel("capture-recording");
                    }
                });
                watching_wheel = watch_wheel;
            }
            if watch_shift != watching_shift {
                hook.shared().with_engine(|engine, _| {
                    if watch_shift {
                        engine.watch_keys("capture-scroll", vec![0x10, 0xA0, 0xA1]);
                    } else {
                        engine.unwatch_keys("capture-scroll");
                    }
                });
                watching_shift = watch_shift;
                shift_pressed = false;
            }
            if let Ok(settings) = app.state::<AppState>().current() {
                if previous.as_ref() != Some(&settings.capture) {
                    bindings.clear();
                    for action in ["pin", "copy", "copy_pin", "edit"] {
                        let key = format!("quick_capture_{action}");
                        let text = settings
                            .capture
                            .native_options
                            .get(&key)
                            .and_then(|v| v.as_str())
                            .unwrap_or(if action == "pin" { "win+dragleft" } else { "" });
                        let mut parts: Vec<_> = text.split('+').collect();
                        let button = parts.pop().unwrap_or("").trim_start_matches("drag");
                        if let (Some(modifiers), Some(button)) =
                            (Modifiers::parse(parts), Button::parse(button))
                        {
                            bindings.push((modifiers, button, action.to_string()));
                        }
                    }
                    hook.shared().with_engine(|engine, emit| {
                        engine.configure_gestures(
                            bindings.iter().map(|(m, b, _)| (*m, *b)).collect(),
                            settings.capture.enabled,
                            emit,
                        );
                    });
                    previous = Some(settings.capture);
                }
            }
            hook.shared().with_engine(|engine, emit| {
                engine.set_blocked(
                    capture::busy(&app) || crate::native_freeze::is_active(),
                    emit,
                )
            });
            let event = match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(event) => event,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            };
            match event {
                Event::Wheel {
                    delta,
                    horizontal,
                    x,
                    y,
                    ..
                } => {
                    if let Ok(mut sessions) = app.state::<capture::CaptureManager>().sessions.lock()
                    {
                        for session in sessions.values_mut() {
                            if !horizontal
                                && session.recorder.as_ref().is_some_and(|r| r.is_recording())
                            {
                                session.cursor.scroll = delta.signum() as i8;
                            }
                            if session.scroll.is_some()
                                && session.region.is_some_and(|r| {
                                    x >= r.x
                                        && y >= r.y
                                        && i64::from(x) < i64::from(r.x) + i64::from(r.width)
                                        && i64::from(y) < i64::from(r.y) + i64::from(r.height)
                                })
                            {
                                session
                                    .scroll_trigger
                                    .wheel(delta, horizontal, session.horizontal);
                            }
                        }
                    }
                }
                Event::Key {
                    watcher, pressed, ..
                } if watcher.as_ref() == "capture-scroll" => {
                    if pressed && !shift_pressed && watching_shift {
                        if let Err(error) = super::capture_platform::scroll_right() {
                            capture::report_capture_error(&app, &error);
                        }
                        if let Ok(mut sessions) =
                            app.state::<capture::CaptureManager>().sessions.lock()
                        {
                            for session in sessions
                                .values_mut()
                                .filter(|s| s.horizontal && s.scroll.is_some())
                            {
                                session.scroll_trigger.wheel(120, true, true);
                            }
                        }
                    }
                    shift_pressed = pressed;
                }
                Event::GestureStart { id, x, y } => {
                    let binding = hook
                        .shared()
                        .with_engine(|engine, _| engine.gesture_binding(id));
                    let action = bindings
                        .iter()
                        .find(|(m, b, _)| Some((*m, *b)) == binding)
                        .map(|(_, _, a)| a.clone())
                        .unwrap_or_else(|| "pin".into());
                    gesture = Some((id, x, y, action));
                    if let Some(window) = app.get_webview_window("capture-quick") {
                        if let Ok(bounds) = super::capture_native::desktop_rect() {
                            let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
                            let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
                            let _ = window.emit(
                                "capture:quick",
                                json!({"start":[x,y],"end":[x,y],"bounds":bounds}),
                            );
                        }
                        let _ = window.show();
                    }
                }
                Event::GestureMoved { id } => {
                    if let Some((_, x, y, _)) = gesture.as_ref().filter(|g| g.0 == id) {
                        if let Some((end_x, end_y)) = hook
                            .shared()
                            .with_engine(|engine, _| engine.take_position(id))
                        {
                            if let Ok(bounds) = super::capture_native::desktop_rect() {
                                let _ = app.emit_to(
                                    "capture-quick",
                                    "capture:quick",
                                    json!({"start":[x,y],"end":[end_x,end_y],"bounds":bounds}),
                                );
                            }
                        }
                    }
                }
                Event::GestureFinish { id, x, y } => {
                    if let Some(window) = app.get_webview_window("capture-quick") {
                        super::lifecycle::force_hide_window(&window);
                        let _ = window.hide();
                    }
                    if let Some((_, sx, sy, action)) = gesture.take().filter(|g| g.0 == id) {
                        let rect = Rect {
                            x: sx.min(x),
                            y: sy.min(y),
                            width: sx.abs_diff(x),
                            height: sy.abs_diff(y),
                        };
                        if rect.width > 1 && rect.height > 1 {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                unsafe {
                                    let _ = windows::Win32::Graphics::Dwm::DwmFlush();
                                }
                                if let Err(error) = capture::quick_start(&app, rect, &action) {
                                    capture::report_capture_error(&app, &error);
                                }
                            });
                        }
                    }
                }
                Event::GestureCancel { .. } => {
                    gesture = None;
                    if let Some(window) = app.get_webview_window("capture-quick") {
                        super::lifecycle::force_hide_window(&window);
                        let _ = window.hide();
                    }
                }
                Event::Failure { message } => {
                    capture::report_capture_error(&app, &message);
                }
                _ => {}
            }
        }
        hook.stop();
    });
}
