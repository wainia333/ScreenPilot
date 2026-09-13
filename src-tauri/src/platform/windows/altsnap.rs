//! Global input hooks; all target-window messages execute on the worker thread.
use crate::domain::altsnap::{GestureCursor, HeldShortcut, ResizeEdges};
use crate::domain::settings::AltSnapSettings;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ValidateRect;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_CONTROL,
};
use windows::Win32::UI::WindowsAndMessaging::*;

#[path = "altsnap_worker.rs"]
mod worker;
use worker::{target_at, Command, Motion};

static SERVICE: OnceLock<Service> = OnceLock::new();
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);
const RESET_INPUT: u32 = WM_APP + 71;
// A target application can set its class cursor while it handles a mouse
// move. Re-assert the gesture cursor from the hook thread's message queue so
// the target cannot leave its own cursor visible during a drag.
const CURSOR_REASSERT_TIMER_REQUEST: usize = 72;
const CURSOR_REASSERT_INTERVAL_MS: u32 = 8;
const CURSOR_OVERLAY_CLASS: windows::core::PCWSTR = windows::core::w!("ScreenPilotAltSnapCursor");
// Keep the pointer inside the overlay between low-level reports. AltSnap uses
// the same 256px tracking window; a tiny window can be left by a single high
// speed mouse report and immediately lose WM_SETCURSOR ownership.
const CURSOR_OVERLAY_WIDTH: i32 = 256;

// AltSnap's RezTimer mode uses the system mouse event time resolution (about
// 16 ms on a normal Windows desktop).  A low-level hook can run at hundreds
// or thousands of reports per second; counting reports therefore makes the
// effective rate depend on the mouse polling rate and can drop a lone move.
// Publish at most one latest point per frame interval instead.  Button-up is
// always delivered separately with its exact final point.
const MOVE_FRAME_INTERVAL: Duration = Duration::from_millis(16);

struct Service {
    config: Mutex<(bool, HeldShortcut)>,
    mailbox: Arc<Mailbox>,
}

#[derive(Default)]
pub(super) struct Mailbox {
    queue: Mutex<VecDeque<Command>>,
    ready: Condvar,
}

impl Mailbox {
    fn send(&self, command: Command) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(command, Command::Move(_)) && matches!(queue.back(), Some(Command::Move(_))) {
            queue.pop_back();
        }
        queue.push_back(command);
        self.ready.notify_one();
    }
    fn receive(&self) -> Command {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(command) = queue.pop_front() {
                return command;
            }
            queue = self.ready.wait(queue).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[derive(Default)]
struct InputState {
    active_button: u32,
    swallowed: u8,
    escape: bool,
    origin: POINT,
    resize_edges: ResizeEdges,
    last_published_at: Option<Instant>,
    last_move: POINT,
    has_last_move: bool,
    cursor: Option<GestureCursor>,
    saved_cursor: usize,
}
impl InputState {
    fn begin(&mut self, button: u32, point: POINT, resize_edges: ResizeEdges) {
        self.active_button = button;
        self.origin = point;
        self.resize_edges = resize_edges;
        self.last_published_at = None;
        self.last_move = point;
        self.has_last_move = true;
        self.cursor = Some(GestureCursor::for_resize_edges(
            button == WM_RBUTTONDOWN,
            resize_edges,
        ));
        self.saved_cursor = current_system_cursor()
            .or_else(|| unsafe { Some(GetCursor()) })
            .map_or(0, |cursor| cursor.0 as usize);
    }

    fn should_publish_move_at(&mut self, now: Instant) -> bool {
        let due = self
            .last_published_at
            .is_none_or(|last| now.duration_since(last) >= MOVE_FRAME_INTERVAL);
        if due {
            self.last_published_at = Some(now);
        }
        due
    }

    fn is_duplicate_move(&mut self, point: POINT) -> bool {
        let duplicate =
            self.has_last_move && self.last_move.x == point.x && self.last_move.y == point.y;
        self.last_move = point;
        self.has_last_move = true;
        duplicate
    }

    fn move_for_publish(&mut self, point: POINT) -> Option<Motion> {
        self.move_for_publish_at(point, Instant::now())
    }

    fn move_for_publish_at(&mut self, point: POINT, now: Instant) -> Option<Motion> {
        let duplicate = self.is_duplicate_move(point);
        let motion = self.motion(point);
        if duplicate {
            return None;
        }
        if !self.should_publish_move_at(now) {
            return None;
        }
        Some(motion)
    }

    fn motion(&mut self, point: POINT) -> Motion {
        Motion {
            point,
            edges: self.resize_edges,
        }
    }

    fn restore_cursor(&mut self) {
        stop_cursor_reassert_timer();
        let had_cursor = self.cursor.take().is_some();
        // Clear the class cursor before hiding the overlay. Otherwise a stale
        // gesture cursor can be reused if USER32 delivers WM_SETCURSOR while
        // the popup is being hidden or during the next gesture setup.
        set_cursor_overlay_class_cursor(self);
        hide_cursor_overlay();
        if had_cursor {
            let saved = HCURSOR(self.saved_cursor as *mut _);
            unsafe {
                let _ = SetCursor(if saved.is_invalid() {
                    None
                } else {
                    Some(saved)
                });
            }
        }
        self.saved_cursor = 0;
    }
}
thread_local! {
    static INPUT_STATE: RefCell<InputState> = RefCell::default();
    // SetTimer assigns a new ID when no window is supplied, so retain the
    // returned value for both message matching and cleanup.
    static CURSOR_REASSERT_TIMER: Cell<usize> = const { Cell::new(0) };
    // This window is created and driven by the hook thread.  Keeping its
    // handle thread-local avoids sending cursor APIs through another thread's
    // message queue.
    static CURSOR_OVERLAY_HWND: Cell<isize> = const { Cell::new(0) };
}

fn gesture_cursor(kind: GestureCursor) -> Option<HCURSOR> {
    let id = match kind {
        GestureCursor::Hand => IDC_HAND,
        GestureCursor::DiagonalResize | GestureCursor::DiagonalResizeNwse => IDC_SIZENWSE,
        GestureCursor::DiagonalResizeNesw => IDC_SIZENESW,
    };
    unsafe {
        LoadCursorW(None, id)
            .ok()
            .or_else(|| LoadCursorW(None, IDC_ARROW).ok())
    }
}

fn current_system_cursor() -> Option<HCURSOR> {
    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetCursorInfo(&mut info).ok().map(|()| info.hCursor) }
}

fn apply_gesture_cursor(state: &InputState) {
    if let Some(kind) = state.cursor {
        unsafe {
            let _ = SetCursor(gesture_cursor(kind));
        }
    }
}

unsafe extern "system" fn cursor_overlay_proc(
    hwnd: HWND,
    message: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    match message {
        // Keep the overlay as the hit-tested window while a gesture is
        // active. This makes Windows deliver WM_SETCURSOR to the hook thread
        // instead of asking the target process for its class cursor.
        WM_NCHITTEST => return LRESULT(HTCLIENT as isize),
        WM_SETCURSOR => {
            let applied = INPUT_STATE.with(|state| {
                let Ok(state) = state.try_borrow() else {
                    return false;
                };
                if state.cursor.is_some() {
                    // Let DefWindowProc perform the normal class-cursor
                    // update after we install the active gesture cursor. This
                    // is the USER32 path that actually refreshes the screen;
                    // returning after SetCursor alone can leave GetCursorInfo
                    // pointing at the previous cursor.
                    set_cursor_overlay_class_cursor(&state);
                    true
                } else {
                    false
                }
            });
            if applied {
                let _ = DefWindowProcW(hwnd, message, w_param, l_param);
                return LRESULT(1);
            }
        }
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => return LRESULT(1),
        WM_PAINT => {
            // This popup has no visible content, but still validate its update
            // region so an invalidation cannot starve the hook thread's timer.
            let _ = ValidateRect(Some(hwnd), None);
            return LRESULT(0);
        }
        WM_NCDESTROY => {
            CURSOR_OVERLAY_HWND.with(|handle| handle.set(0));
        }
        _ => {}
    }
    DefWindowProcW(hwnd, message, w_param, l_param)
}

fn cursor_overlay_hwnd() -> Option<HWND> {
    CURSOR_OVERLAY_HWND.with(|handle| {
        let raw = handle.get();
        (raw != 0).then_some(HWND(raw as *mut c_void))
    })
}

fn ensure_cursor_overlay() -> Option<HWND> {
    if let Some(hwnd) = cursor_overlay_hwnd() {
        if unsafe { IsWindow(Some(hwnd)).as_bool() } {
            return Some(hwnd);
        }
        CURSOR_OVERLAY_HWND.with(|handle| handle.set(0));
    }

    unsafe {
        let instance = GetModuleHandleW(None).ok()?.into();
        let class = WNDCLASSW {
            lpfnWndProc: Some(cursor_overlay_proc),
            hInstance: instance,
            // Keep the class cursor null until a gesture starts. During a
            // gesture, set_cursor_overlay_class_cursor installs the selected
            // cursor so USER32 can restore it on every mouse move.
            hCursor: HCURSOR::default(),
            lpszClassName: CURSOR_OVERLAY_CLASS,
            ..Default::default()
        };
        // RegisterClassW returns zero when this process has already registered
        // the class. The existing class is still valid for CreateWindowExW.
        let _ = RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            // The popup paints nothing and all gesture button events are
            // already swallowed by the low-level hook, so it can own the
            // hit-test while active without activating the target.
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            CURSOR_OVERLAY_CLASS,
            windows::core::w!("ScreenPilot cursor overlay"),
            WS_POPUP,
            0,
            0,
            CURSOR_OVERLAY_WIDTH,
            CURSOR_OVERLAY_WIDTH,
            None,
            None,
            Some(instance),
            None,
        )
        .ok()?;
        CURSOR_OVERLAY_HWND.with(|handle| handle.set(hwnd.0 as isize));
        Some(hwnd)
    }
}

fn position_cursor_overlay(point: POINT) {
    let Some(hwnd) = ensure_cursor_overlay() else {
        return;
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            point.x - CURSOR_OVERLAY_WIDTH / 2,
            point.y - CURSOR_OVERLAY_WIDTH / 2,
            CURSOR_OVERLAY_WIDTH,
            CURSOR_OVERLAY_WIDTH,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

fn set_cursor_overlay_class_cursor(state: &InputState) {
    let Some(hwnd) = cursor_overlay_hwnd() else {
        return;
    };
    let cursor = state.cursor.and_then(gesture_cursor);
    unsafe {
        let _ = SetClassLongPtrW(
            hwnd,
            GCLP_HCURSOR,
            cursor.map_or(0, |cursor| cursor.0 as isize),
        );
    }
}

fn show_gesture_cursor(state: &InputState, point: POINT) {
    // Direct SetCursor covers the button-down instant. The topmost tracking
    // window then owns WM_SETCURSOR for every subsequent move, so a target
    // cannot restore its own class cursor after the low-level hook.
    set_cursor_overlay_class_cursor(state);
    position_cursor_overlay(point);
    apply_gesture_cursor(state);
}

fn hide_cursor_overlay() {
    if let Some(hwnd) = cursor_overlay_hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn destroy_cursor_overlay() {
    if let Some(hwnd) = cursor_overlay_hwnd() {
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
    }
}

fn reassert_gesture_cursor(state: &InputState) {
    let mut point = POINT::default();
    unsafe {
        if GetCursorPos(&mut point).is_ok() {
            set_cursor_overlay_class_cursor(state);
            position_cursor_overlay(point);
        }
    }
    apply_gesture_cursor(state);
}

fn start_cursor_reassert_timer() {
    CURSOR_REASSERT_TIMER.with(|timer| {
        if timer.get() == 0 {
            let id = unsafe {
                SetTimer(
                    None,
                    CURSOR_REASSERT_TIMER_REQUEST,
                    CURSOR_REASSERT_INTERVAL_MS,
                    None,
                )
            };
            timer.set(id);
        }
    });
}

fn stop_cursor_reassert_timer() {
    CURSOR_REASSERT_TIMER.with(|timer| {
        let id = timer.replace(0);
        if id != 0 {
            unsafe {
                let _ = KillTimer(None, id);
            }
        }
    });
}

fn is_cursor_reassert_timer(message: &MSG) -> bool {
    CURSOR_REASSERT_TIMER.with(|timer| {
        timer.get() != 0 && message.message == WM_TIMER && message.wParam.0 == timer.get()
    })
}

pub fn start(settings: &AltSnapSettings) -> Result<(), String> {
    let shortcut = HeldShortcut::parse(&settings.shortcut)?;
    let mailbox = Arc::new(Mailbox::default());
    SERVICE
        .set(Service {
            config: Mutex::new((settings.enabled, shortcut)),
            mailbox: mailbox.clone(),
        })
        .map_err(|_| "AltSnap is already initialized".to_string())?;
    let (ready, status) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("altsnap-windows".into())
        .spawn(move || worker::run(mailbox))
        .map_err(|e| e.to_string())?;
    if let Err(error) = thread::Builder::new()
        .name("altsnap-input".into())
        .spawn(move || unsafe {
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            // Create the cursor owner before installing the low-level hook so
            // the first Alt+button down does not perform window-class setup in
            // the hook callback's critical path.
            let _ = ensure_cursor_overlay();
            let module = GetModuleHandleW(None).ok().map(Into::into);
            let hooks =
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0).and_then(|mouse| {
                    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) {
                        Ok(keyboard) => Ok((mouse, keyboard)),
                        Err(error) => {
                            let _ = UnhookWindowsHookEx(mouse);
                            Err(error)
                        }
                    }
                });
            let (mouse, keyboard) = match hooks {
                Ok(hooks) => hooks,
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            HOOK_THREAD.store(GetCurrentThreadId(), Ordering::Release);
            RUNNING.store(true, Ordering::Release);
            let _ = ready.send(Ok(()));
            // A swallowed mouse DOWN does not update GetAsyncKeyState. Never poll
            // it to decide whether a captured gesture ended; consume the real UP.
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == RESET_INPUT {
                    cancel_input();
                } else if is_cursor_reassert_timer(&message) {
                    INPUT_STATE.with(|state| {
                        if let Ok(state) = state.try_borrow() {
                            reassert_gesture_cursor(&state);
                        }
                    });
                } else {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            // WM_QUIT can arrive while a button is still held. Restore the
            // cursor before removing the hook so it cannot leak into the rest
            // of the desktop after ScreenPilot is stopped.
            cancel_input();
            destroy_cursor_overlay();
            let _ = UnhookWindowsHookEx(keyboard);
            let _ = UnhookWindowsHookEx(mouse);
            RUNNING.store(false, Ordering::Release);
            HOOK_THREAD.store(0, Ordering::Release);
            send(Command::Stop);
        })
    {
        send(Command::Stop);
        return Err(error.to_string());
    }
    let result = status
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    if result.is_err() {
        send(Command::Stop);
    }
    result
}

pub fn update(settings: &AltSnapSettings) -> Result<(), String> {
    let shortcut = HeldShortcut::parse(&settings.shortcut)?;
    let service = SERVICE
        .get()
        .ok_or("AltSnap input service is unavailable")?;
    if settings.enabled && !RUNNING.load(Ordering::Acquire) {
        return Err("AltSnap input hooks are unavailable; restart ScreenPilot".into());
    }
    let mut config = service.config.lock().unwrap_or_else(|e| e.into_inner());
    if *config == (settings.enabled, shortcut.clone()) {
        return Ok(());
    }
    *config = (settings.enabled, shortcut);
    drop(config);
    let id = HOOK_THREAD.load(Ordering::Acquire);
    if id != 0 {
        unsafe {
            PostThreadMessageW(id, RESET_INPUT, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn stop() {
    let id = HOOK_THREAD.load(Ordering::Acquire);
    if id != 0 {
        let _ = unsafe { PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
    send(Command::Stop);
}

fn send(command: Command) {
    if let Some(service) = SERVICE.get() {
        service.mailbox.send(command);
    }
}
fn key_down(key: u16) -> bool {
    unsafe { GetAsyncKeyState(i32::from(key)) < 0 }
}
fn held(shortcut: &HeldShortcut) -> bool {
    shortcut.0.iter().all(|&key| {
        if key == 0x5b {
            key_down(0x5b) || key_down(0x5c)
        } else {
            key_down(key)
        }
    })
}
fn cancel_input() {
    INPUT_STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.active_button != 0 {
            send(Command::Cancel);
            state.active_button = 0;
        }
        state.restore_cursor();
    });
}

// As in AltSnap, a Ctrl pair disguises an Alt/Win gesture from the menu.
// Do not swallow modifier key-up: that would leave the application key state stuck.
fn mask_modifier_menu() {
    if key_down(0x11) || !(key_down(0x12) || key_down(0x5b) || key_down(0x5c)) {
        return;
    }
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_CONTROL,
                ..Default::default()
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_CONTROL,
                dwFlags: KEYEVENTF_KEYUP,
                ..Default::default()
            },
        },
    };
    let _ = unsafe { SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) };
}

unsafe extern "system" fn keyboard_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if key.vkCode == 0x1b {
            let consume = INPUT_STATE.with(|state| {
                let Ok(mut state) = state.try_borrow_mut() else {
                    return false;
                };
                if matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN) && state.active_button != 0 {
                    state.active_button = 0;
                    state.escape = true;
                    send(Command::Cancel);
                    state.restore_cursor();
                    true
                } else if matches!(w.0 as u32, WM_KEYUP | WM_SYSKEYUP) && state.escape {
                    state.escape = false;
                    true
                } else {
                    state.escape
                }
            });
            if consume {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, w, l);
    }
    let info = &*(l.0 as *const MSLLHOOKSTRUCT);
    // Remote input and accessibility tools also use SendInput. AltSnap accepts
    // those events; only input synthesized by this feature needs filtering.
    let message = w.0 as u32;
    let mut mask_menu = false;
    let consume = INPUT_STATE.with(|state| {
        // Win32 APIs may dispatch nested hook callbacks. Never unwind across
        // the system ABI if one arrives during target lookup.
        let Ok(mut state) = state.try_borrow_mut() else {
            return false;
        };
        let bit = match message {
            WM_LBUTTONDOWN | WM_LBUTTONUP => 1,
            WM_RBUTTONDOWN | WM_RBUTTONUP => 2,
            _ => 0,
        };
        if matches!(message, WM_LBUTTONUP | WM_RBUTTONUP) && state.swallowed & bit != 0 {
            state.swallowed &= !bit;
            if state.active_button == message - 1 {
                send(Command::End(state.motion(info.pt)));
                state.active_button = 0;
                state.restore_cursor();
            }
            return true;
        }
        if message == WM_MOUSEMOVE && state.active_button != 0 {
            // SetCursor alone is not sufficient: the target may set its
            // class cursor while handling the same move. Reassert here and
            // from the timer below so the gesture cursor stays visible.
            apply_gesture_cursor(&state);
            // Low-level hooks may report the same physical point repeatedly.
            // Filter those before the MoveRate/ResizeRate counter so
            // duplicates do not consume a useful update slot.
            if let Some(motion) = state.move_for_publish(info.pt) {
                send(Command::Move(motion));
            }
            // AltSnap observes movement but lets Windows update the cursor.
            // Swallowing MOVE leaves the physical cursor at the grab point;
            // subsequent relative moves and the button-up then use that stale
            // position and undo the drag.
            return false;
        }
        if !matches!(message, WM_LBUTTONDOWN | WM_RBUTTONDOWN) {
            return false;
        }
        if state.active_button != 0 {
            state.swallowed |= bit;
            return true;
        }
        if state.swallowed != 0 {
            return false;
        }
        let Some(service) = SERVICE.get() else {
            return false;
        };
        let config = service.config.lock().unwrap_or_else(|e| e.into_inner());
        if !config.0 || !held(&config.1) {
            return false;
        }
        drop(config);
        let Some(target) = target_at(info.pt) else {
            return false;
        };
        if key_down(if bit == 1 { 2 } else { 1 }) {
            return false;
        }
        let focus = key_down(0x11);
        mask_menu = true;
        let resize = message == WM_RBUTTONDOWN;
        let edges = if resize {
            ResizeEdges::from_grab_point((info.pt.x, info.pt.y), target.rect)
        } else {
            ResizeEdges::default()
        };
        state.begin(message, info.pt, edges);
        state.swallowed |= bit;
        show_gesture_cursor(&state, info.pt);
        start_cursor_reassert_timer();
        send(Command::Begin {
            target,
            point: info.pt,
            resize,
            edges,
            focus,
        });
        true
    });
    // SendInput can synchronously dispatch keyboard AND mouse callbacks.
    // Publish the gesture and release the state borrow before calling it.
    if mask_menu {
        mask_modifier_menu();
    }
    if consume {
        LRESULT(1)
    } else {
        CallNextHookEx(None, code, w, l)
    }
}

#[cfg(test)]
mod cursor_tests {
    use super::*;

    #[test]
    fn cursor_state_captures_mode_and_releases_saved_cursor() {
        for (button, expected) in [
            (WM_LBUTTONDOWN, GestureCursor::Hand),
            (WM_RBUTTONDOWN, GestureCursor::DiagonalResizeNwse),
        ] {
            let mut state = InputState::default();
            let edges = if button == WM_RBUTTONDOWN {
                ResizeEdges {
                    x: Some(crate::domain::altsnap::Edge::Far),
                    y: Some(crate::domain::altsnap::Edge::Far),
                }
            } else {
                ResizeEdges::default()
            };
            state.begin(button, POINT { x: 20, y: 30 }, edges);
            assert_eq!(state.cursor, Some(expected));
            assert_ne!(state.saved_cursor, 0);

            state.restore_cursor();
            assert_eq!(state.cursor, None);
            assert_eq!(state.saved_cursor, 0);
        }
    }
}

#[cfg(test)]
#[path = "altsnap_native_tests.rs"]
mod native_tests;
