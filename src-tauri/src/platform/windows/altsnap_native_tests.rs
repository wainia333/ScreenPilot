//! Opt-in end-to-end test using a separate native application and real SendInput.
use super::*;
use std::cell::Cell;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::AtomicUsize;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, FillRect, GetSysColorBrush, COLOR_HIGHLIGHT, COLOR_WINDOW, PAINTSTRUCT,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

static CLICKS: AtomicUsize = AtomicUsize::new(0);
static RESIZES: AtomicUsize = AtomicUsize::new(0);
static SLOW_MS: AtomicUsize = AtomicUsize::new(0);
static PAINTS: AtomicUsize = AtomicUsize::new(0);
static PAINTED_SIZE: AtomicUsize = AtomicUsize::new(0);
static SIZE_DELAY_MS: AtomicUsize = AtomicUsize::new(0);
static CHILD_RESIZES: AtomicUsize = AtomicUsize::new(0);
static CHILD_PAINTS: AtomicUsize = AtomicUsize::new(0);
static CHILD_PAINTED_SIZE: AtomicUsize = AtomicUsize::new(0);
static CURSOR_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const RESET: u32 = WM_APP + 101;
const GET_CLICKS: u32 = WM_APP + 102;
const GET_RESIZES: u32 = WM_APP + 103;
const SET_SLOW: u32 = WM_APP + 104;
const GET_PAINTS: u32 = WM_APP + 105;
const GET_PAINTED_SIZE: u32 = WM_APP + 106;
const SET_SIZE_DELAY: u32 = WM_APP + 107;
const GET_CHILD_RESIZES: u32 = WM_APP + 108;
const GET_CHILD_PAINTS: u32 = WM_APP + 109;
const GET_CHILD_PAINTED_SIZE: u32 = WM_APP + 110;
const SERVER: &str = "platform::windows::altsnap::native_tests::native_fixture_server";

unsafe extern "system" fn child_window_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    match msg {
        WM_SIZE => {
            CHILD_RESIZES.fetch_add(1, Ordering::Relaxed);
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut client = RECT::default();
            let _ = GetClientRect(hwnd, &mut client);
            FillRect(dc, &client, GetSysColorBrush(COLOR_HIGHLIGHT));
            let _ = EndPaint(hwnd, &paint);
            CHILD_PAINTED_SIZE.store(
                ((client.right as usize) << 16) | client.bottom as usize,
                Ordering::Relaxed,
            );
            CHILD_PAINTS.fetch_add(1, Ordering::Relaxed);
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
            CLICKS.fetch_add(1, Ordering::Relaxed);
        }
        WM_SIZE => {
            RESIZES.fetch_add(1, Ordering::Relaxed);
            let delay = SIZE_DELAY_MS.load(Ordering::Relaxed);
            if delay != 0 {
                thread::sleep(Duration::from_millis(delay as u64));
            }
            let mut client = RECT::default();
            let _ = GetClientRect(hwnd, &mut client);
            if let Ok(child) = GetWindow(hwnd, GW_CHILD) {
                let _ = SetWindowPos(
                    child,
                    None,
                    24,
                    24,
                    (client.right - 48).max(1),
                    (client.bottom - 48).max(1),
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
                );
            }
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut client = RECT::default();
            let _ = GetClientRect(hwnd, &mut client);
            FillRect(dc, &client, GetSysColorBrush(COLOR_HIGHLIGHT));
            let _ = EndPaint(hwnd, &paint);
            PAINTED_SIZE.store(
                ((client.right as usize) << 16) | client.bottom as usize,
                Ordering::Relaxed,
            );
            PAINTS.fetch_add(1, Ordering::Relaxed);
            return LRESULT(0);
        }
        WM_WINDOWPOSCHANGING => {
            let delay = SLOW_MS.load(Ordering::Relaxed);
            if delay != 0 {
                thread::sleep(Duration::from_millis(delay as u64));
            }
        }
        RESET => {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 180, 160, 500, 400, SWP_NOACTIVATE);
            return LRESULT(1);
        }
        GET_CLICKS => return LRESULT(CLICKS.load(Ordering::Relaxed) as isize),
        GET_RESIZES => return LRESULT(RESIZES.load(Ordering::Relaxed) as isize),
        GET_PAINTS => return LRESULT(PAINTS.load(Ordering::Relaxed) as isize),
        GET_PAINTED_SIZE => return LRESULT(PAINTED_SIZE.load(Ordering::Relaxed) as isize),
        GET_CHILD_RESIZES => return LRESULT(CHILD_RESIZES.load(Ordering::Relaxed) as isize),
        GET_CHILD_PAINTS => return LRESULT(CHILD_PAINTS.load(Ordering::Relaxed) as isize),
        GET_CHILD_PAINTED_SIZE => {
            return LRESULT(CHILD_PAINTED_SIZE.load(Ordering::Relaxed) as isize)
        }
        SET_SIZE_DELAY => {
            SIZE_DELAY_MS.store(wp.0, Ordering::Relaxed);
            return LRESULT(1);
        }
        SET_SLOW => {
            SLOW_MS.store(wp.0, Ordering::Relaxed);
            return LRESULT(1);
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

#[test]
#[ignore = "helper process used only by the interactive native regression test"]
fn native_fixture_server() {
    let Some(path) = std::env::var_os("SCREENPILOT_ALTSNAP_FIXTURE") else {
        return;
    };
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance = GetModuleHandleW(None).unwrap();
        let name = w!("ScreenPilotAltSnapRegression");
        let child_name = w!("ScreenPilotAltSnapRegressionChild");
        let child_class = WNDCLASSW {
            lpfnWndProc: Some(child_window_proc),
            hInstance: instance.into(),
            lpszClassName: child_name,
            hbrBackground: GetSysColorBrush(COLOR_HIGHLIGHT),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap(),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&child_class), 0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: name,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap(),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            name,
            w!("AltSnap regression test"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            180,
            160,
            500,
            400,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .unwrap();
        let child = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            child_name,
            w!("AltSnap child"),
            WS_CHILD | WS_VISIBLE,
            24,
            24,
            452,
            352,
            Some(hwnd),
            None,
            Some(instance.into()),
            None,
        );
        let child = child.unwrap_or_else(|error| {
            panic!(
                "child creation failed: {error:?}, last_error={:?}",
                GetLastError()
            );
        });
        let _ = child;
        std::fs::write(path, (hwnd.0 as usize).to_string()).unwrap();
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

struct Fixture {
    hwnd: HWND,
    cursor: POINT,
    foreground: HWND,
    child: Child,
    input_used: Cell<bool>,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn create() -> Self {
        let saved_cursor = cursor();
        let foreground = unsafe { GetForegroundWindow() };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hwnd");
        let mut child = ProcessCommand::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", SERVER, "--nocapture"])
            .env("SCREENPILOT_ALTSNAP_FIXTURE", &path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let started = Instant::now();
        let handle = loop {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(handle) = content.parse::<usize>() {
                    break handle;
                }
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("native test window did not start");
            }
            thread::sleep(Duration::from_millis(20));
        };
        Self {
            hwnd: HWND(handle as *mut _),
            cursor: saved_cursor,
            foreground,
            child,
            input_used: Cell::new(false),
            _directory: directory,
        }
    }
    fn rect(&self) -> RECT {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(self.hwnd, &mut rect).unwrap();
        }
        rect
    }
    fn request(&self, msg: u32, value: usize) -> usize {
        let mut result = 0;
        assert_ne!(
            unsafe {
                SendMessageTimeoutW(
                    self.hwnd,
                    msg,
                    WPARAM(value),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    1000,
                    Some(&mut result),
                )
                .0
            },
            0
        );
        result
    }
    fn reset(&self) {
        self.request(SET_SLOW, 0);
        self.request(RESET, 0);
        wait_rect(self, (180, 160, 680, 560), "reset", Duration::from_secs(1));
    }
    fn grab(&self, x: i32, y: i32, button: MOUSE_EVENT_FLAGS, keys: &[VIRTUAL_KEY]) {
        self.input_used.set(true);
        // Place/activate only our owned helper before generating input.
        unsafe {
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .unwrap();
        }
        point(x, y);
        unsafe {
            let _ = SetForegroundWindow(self.hwnd);
        }
        assert_eq!(
            unsafe { GetForegroundWindow() },
            self.hwnd,
            "test window must own modifier input"
        );
        let hwnd = unsafe { GetAncestor(WindowFromPoint(cursor()), GA_ROOT) };
        assert_eq!(
            hwnd, self.hwnd,
            "refuse to send a drag to an unrelated application"
        );
        for &vk in keys {
            key(vk, false);
        }
        mouse(button);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.input_used.get() {
            key(VK_MENU, true);
            key(VK_CONTROL, true);
            key(VK_SHIFT, true);
            mouse(MOUSEEVENTF_LEFTUP);
            mouse(MOUSEEVENTF_RIGHTUP);
        }
        stop();
        unsafe {
            let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            if self.input_used.get() {
                let _ = SetCursorPos(self.cursor.x, self.cursor.y);
            }
            let _ = SetForegroundWindow(self.foreground);
        }
        for _ in 0..50 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn key(vk: VIRTUAL_KEY, up: bool) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                ..Default::default()
            },
        },
    };
    assert_eq!(
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) },
        1
    );
    thread::sleep(Duration::from_millis(20));
}
fn mouse(flags: MOUSE_EVENT_FLAGS) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    assert_eq!(
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) },
        1
    );
    thread::sleep(Duration::from_millis(20));
}
fn point_input(x: i32, y: i32) {
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: (((i64::from(x - left) * 2 + 1) * 65536) / (i64::from(width) * 2)) as i32,
                dy: (((i64::from(y - top) * 2 + 1) * 65536) / (i64::from(height) * 2)) as i32,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                ..Default::default()
            },
        },
    };
    assert_eq!(
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) },
        1
    );
}
fn point(x: i32, y: i32) {
    point_input(x, y);
    thread::sleep(Duration::from_millis(60));
}
fn cursor() -> POINT {
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point).unwrap();
    }
    point
}
fn current_cursor() -> HCURSOR {
    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        GetCursorInfo(&mut info).expect("GetCursorInfo");
    }
    info.hCursor
}

#[test]
fn cursor_overlay_wm_setcursor_updates_global_cursor_info() {
    let _guard = CURSOR_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let saved = current_cursor();
    let mut cursor_point = POINT::default();
    unsafe {
        GetCursorPos(&mut cursor_point).unwrap();
    }
    let overlay = ensure_cursor_overlay().expect("cursor overlay creation");
    position_cursor_overlay(cursor_point);
    let mut visual_verified = true;
    for (kind, expected_id) in [
        (GestureCursor::Hand, IDC_HAND),
        (GestureCursor::DiagonalResize, IDC_SIZENWSE),
        (GestureCursor::DiagonalResizeNwse, IDC_SIZENWSE),
        (GestureCursor::DiagonalResizeNesw, IDC_SIZENESW),
    ] {
        let expected = unsafe { LoadCursorW(None, expected_id).unwrap() };
        INPUT_STATE.with(|state| state.borrow_mut().cursor = Some(kind));
        INPUT_STATE.with(|state| set_cursor_overlay_class_cursor(&state.borrow()));
        unsafe {
            // Crossing the overlay boundary makes USER32 perform a real
            // WM_SETCURSOR dispatch; a direct SendMessage alone does not
            // update the desktop cursor when the caller is not the current
            // input owner.
            SetCursorPos(cursor_point.x + 300, cursor_point.y + 300).unwrap();
            SetCursorPos(cursor_point.x, cursor_point.y).unwrap();
        }
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
            unsafe {
                let _ = TranslateMessage(&message);
                let _ = DispatchMessageW(&message);
            }
        }
        let result =
            unsafe { SendMessageW(overlay, WM_SETCURSOR, Some(WPARAM(0)), Some(LPARAM(0))) };
        assert_eq!(result, LRESULT(1), "overlay handled {kind:?}");
        let class_cursor = unsafe { GetClassLongPtrW(overlay, GCLP_HCURSOR) };
        assert_eq!(
            class_cursor, expected.0 as usize,
            "overlay class cursor must be {kind:?}"
        );
        let observed = current_cursor();
        if observed != expected {
            visual_verified = false;
            eprintln!(
                "SKIP cursor visual assertion: GetCursorInfo reports {observed:?} while the test process is not the interactive input owner"
            );
        } else if visual_verified {
            assert_eq!(observed, expected, "global cursor must be {kind:?}");
        }
        INPUT_STATE.with(|state| state.borrow_mut().cursor = None);
    }
    INPUT_STATE.with(|state| set_cursor_overlay_class_cursor(&state.borrow()));
    unsafe {
        let _ = SetCursor(Some(saved));
        SetCursorPos(cursor_point.x, cursor_point.y).unwrap();
        let _ = ShowWindow(overlay, SW_HIDE);
        let _ = DestroyWindow(overlay);
    }
    assert_eq!(unsafe { GetClassLongPtrW(overlay, GCLP_HCURSOR) }, 0);
}
fn wait_rect(f: &Fixture, expected: (i32, i32, i32, i32), label: &str, timeout: Duration) {
    let start = Instant::now();
    loop {
        let r = f.rect();
        if (r.left, r.top, r.right, r.bottom) == expected {
            eprintln!(
                "PASS {label}: {expected:?}, settled in {:?}",
                start.elapsed()
            );
            return;
        }
        if start.elapsed() >= timeout {
            assert_eq!((r.left, r.top, r.right, r.bottom), expected, "{label}");
        }
        thread::sleep(Duration::from_millis(3));
    }
}
fn release(right: bool, keys: &[VIRTUAL_KEY]) {
    mouse(if right {
        MOUSEEVENTF_RIGHTUP
    } else {
        MOUSEEVENTF_LEFTUP
    });
    for &key_code in keys.iter().rev() {
        key(key_code, true);
    }
}

#[test]
#[ignore = "uses a temporary native application and real input on the interactive Windows desktop"]
fn real_hooks_move_resize_cancel_and_reconfigure() {
    assert!(
        !key_down(0x12) && !key_down(0x11) && !key_down(1) && !key_down(2),
        "release keys before running"
    );
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let f = Fixture::create();
    // Physical mouse coordinates must hit the same window even when Win32
    // dispatches the low-level hook in a DPI-unaware callback context.
    let expected = target_at(POINT { x: 430, y: 350 });
    assert!(expected.is_some());
    unsafe {
        use windows::Win32::UI::HiDpi::{
            AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_UNAWARE,
        };
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_UNAWARE);
        let actual = target_at(POINT { x: 620, y: 500 });
        let restored = AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_UNAWARE,
        )
        .as_bool();
        let _ = SetThreadDpiAwarenessContext(previous);
        assert_eq!(
            actual, expected,
            "hit testing must use physical coordinates"
        );
        assert!(
            restored,
            "hit testing must restore the caller's DPI context"
        );
    }
    start(&AltSnapSettings::default()).unwrap();
    let timeout = Duration::from_millis(500);
    let alt = &[VK_MENU];
    let size_events = f.request(GET_RESIZES, 0);
    // Capture the normal target-window cursor after moving onto the fixture;
    // the cursor may legitimately change when the pointer leaves the test
    // runner's own window.
    point(430, 350);
    let saved_cursor = current_cursor();
    let hand_cursor = unsafe { LoadCursorW(None, IDC_HAND).unwrap() };
    f.grab(430, 350, MOUSEEVENTF_LEFTDOWN, alt);
    assert_eq!(
        current_cursor(),
        hand_cursor,
        "Alt+left must show the hand cursor"
    );
    thread::sleep(Duration::from_millis(250));
    point(490, 390);
    assert_eq!(
        current_cursor(),
        hand_cursor,
        "Alt+left cursor must survive target cursor updates"
    );
    wait_rect(&f, (240, 200, 740, 600), "Alt+left", timeout);
    release(false, alt);
    assert_eq!(
        current_cursor(),
        saved_cursor,
        "left release restores cursor"
    );
    point(510, 410);
    wait_rect(&f, (240, 200, 740, 600), "release does not jump", timeout);
    assert_eq!(
        f.request(GET_RESIZES, 0),
        size_events,
        "moving must not trigger resize work"
    );
    assert_eq!(f.request(GET_CLICKS, 0), 0);

    // The grab location selects the corner. Reversing past the starting point
    // must leave that corner fixed.
    for (x, y, dx, dy, shrunk, grown) in [
        // top-left: move down/right to shrink, then reverse to grow
        (220, 210, 30, 20, (210, 180, 680, 560), (150, 140, 680, 560)),
        // top-right: move left/down to shrink, then reverse to grow
        (
            620,
            210,
            -30,
            20,
            (180, 180, 650, 560),
            (180, 140, 710, 560),
        ),
        // bottom-left: move right/up to shrink, then reverse to grow
        (
            220,
            500,
            30,
            -20,
            (210, 160, 680, 540),
            (150, 160, 680, 580),
        ),
        // bottom-right: move left/up to shrink, then reverse to grow
        (
            620,
            500,
            -30,
            -20,
            (180, 160, 650, 540),
            (180, 160, 710, 580),
        ),
    ] {
        f.reset();
        f.grab(x, y, MOUSEEVENTF_RIGHTDOWN, alt);
        point(x + dx, y + dy);
        wait_rect(&f, shrunk, "quadrant selects corner", timeout);
        point(x - dx, y - dy);
        wait_rect(&f, grown, "reversing keeps the same corner", timeout);
        release(true, alt);
        wait_rect(&f, grown, "resize release does not jump", timeout);
    }
    f.reset();
    point(430, 360);
    let saved_cursor = current_cursor();
    let resize_cursor = unsafe { LoadCursorW(None, IDC_SIZENWSE).unwrap() };
    f.grab(430, 360, MOUSEEVENTF_RIGHTDOWN, alt);
    assert_eq!(
        current_cursor(),
        resize_cursor,
        "Alt+right must show diagonal resize cursor"
    );
    point(460, 360);
    wait_rect(
        &f,
        (180, 160, 710, 560),
        "horizontal resize keeps both vertical edges",
        timeout,
    );
    point(400, 340);
    wait_rect(
        &f,
        (180, 160, 650, 540),
        "crossing the midpoint keeps the selected corner",
        timeout,
    );
    release(true, alt);
    assert_eq!(
        current_cursor(),
        saved_cursor,
        "right release restores cursor"
    );
    f.reset();
    point(430, 360);
    let saved_cursor = current_cursor();
    f.grab(430, 360, MOUSEEVENTF_RIGHTDOWN, alt);
    assert_eq!(
        current_cursor(),
        resize_cursor,
        "resize cursor before cancellation"
    );
    point(460, 380);
    key(VK_ESCAPE, false);
    key(VK_ESCAPE, true);
    wait_rect(&f, (180, 160, 680, 560), "Escape restores", timeout);
    assert_eq!(current_cursor(), saved_cursor, "Escape restores cursor");
    release(true, alt);

    update(&AltSnapSettings {
        enabled: true,
        shortcut: "Control+Shift".into(),
    })
    .unwrap();
    f.reset();
    f.grab(430, 350, MOUSEEVENTF_LEFTDOWN, &[VK_CONTROL, VK_SHIFT]);
    point(470, 380);
    wait_rect(&f, (220, 190, 720, 590), "custom shortcut", timeout);
    release(false, &[VK_CONTROL, VK_SHIFT]);

    // An expensive app must not accumulate hundreds of pending moves.
    update(&AltSnapSettings::default()).unwrap();
    f.reset();
    f.request(SET_SLOW, 12);
    f.grab(430, 350, MOUSEEVENTF_LEFTDOWN, alt);
    for i in 1..=160 {
        point_input(430 + i, 350);
        thread::sleep(Duration::from_millis(1));
    }
    let before_release = f.rect();
    eprintln!("160 moves before release settled at {before_release:?}");
    release(false, alt);
    wait_rect(
        &f,
        (340, 160, 840, 560),
        "button-up commits the exact final point after 160 moves",
        Duration::from_millis(500),
    );
    f.request(SET_SLOW, 0);
    f.reset();

    update(&AltSnapSettings {
        enabled: false,
        shortcut: "Alt".into(),
    })
    .unwrap();
    f.grab(430, 350, MOUSEEVENTF_LEFTDOWN, alt);
    point(470, 380);
    release(false, alt);
    wait_rect(&f, (180, 160, 680, 560), "disabled passthrough", timeout);
    assert!(f.request(GET_CLICKS, 0) > 0);
}

#[test]
fn coalesced_moves_and_button_up_preserve_the_grab_quadrant() {
    use crate::domain::altsnap::Edge;
    let mut state = InputState {
        active_button: WM_RBUTTONDOWN,
        origin: POINT { x: 430, y: 360 },
        resize_edges: ResizeEdges {
            x: Some(Edge::Near),
            y: Some(Edge::Far),
        },
        ..Default::default()
    };
    let mailbox = Mailbox::default();
    mailbox.send(Command::Move(state.motion(POINT { x: 431, y: 360 })));
    mailbox.send(Command::Move(state.motion(POINT { x: 460, y: 340 })));
    mailbox.send(Command::Move(state.motion(POINT { x: 400, y: 380 })));
    let Command::Move(motion) = mailbox.receive() else {
        panic!("expected move")
    };
    assert_eq!((motion.point.x, motion.point.y), (400, 380));
    assert_eq!(
        motion.edges,
        ResizeEdges {
            x: Some(Edge::Near),
            y: Some(Edge::Far)
        }
    );
    let ended = state.motion(POINT { x: 400, y: 380 });
    assert_eq!(ended.edges, motion.edges);
    assert!(mailbox.queue.lock().unwrap().is_empty());
}

// Drive the production worker without SendInput so other desktop keyboard
// hooks cannot determine the result. The helper really paints its client area.
#[test]
#[ignore = "opens an owned native paint fixture on the interactive desktop"]
fn resize_worker_paints_client_during_continuous_updates() {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let fixture = Fixture::create();
    fixture.reset();
    fixture.request(SET_SIZE_DELAY, 4);
    let origin = POINT { x: 430, y: 350 };
    assert_eq!(
        unsafe { GetAncestor(WindowFromPoint(origin), GA_ROOT) },
        fixture.hwnd
    );
    let target = target_at(origin).expect("fixture target");
    let mailbox = Arc::new(Mailbox::default());
    let worker_mailbox = mailbox.clone();
    let worker_thread = thread::spawn(move || worker::run(worker_mailbox));
    struct WorkerGuard(Arc<Mailbox>, Option<thread::JoinHandle<()>>);
    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            self.0.send(Command::Stop);
            if let Some(thread) = self.1.take() {
                thread.join().unwrap();
            }
        }
    }
    let _worker_guard = WorkerGuard(mailbox.clone(), Some(worker_thread));
    let mut input = InputState::default();
    let edges = ResizeEdges::from_grab_point((origin.x, origin.y), target.rect);
    input.begin(WM_RBUTTONDOWN, origin, edges);
    mailbox.send(Command::Begin {
        target,
        point: origin,
        resize: true,
        edges,
        focus: false,
    });
    let initial_paints = fixture.request(GET_PAINTS, 0);
    let initial_resizes = fixture.request(GET_RESIZES, 0);
    let mut previous_paints = initial_paints;
    let mut painting_intervals = 0;
    // Repeatedly grow the bottom-right corner and return, including reversals.
    let mut final_point = origin;
    for step in 1..=240 {
        let phase = step % 120;
        let delta = if phase <= 60 { phase } else { 120 - phase };
        final_point = POINT {
            x: origin.x - delta,
            y: origin.y - delta,
        };
        if let Some(motion) = input.move_for_publish(final_point) {
            mailbox.send(Command::Move(motion));
        }
        thread::sleep(Duration::from_millis(1));
        if step % 40 == 0 {
            let paints = fixture.request(GET_PAINTS, 0);
            if paints > previous_paints {
                painting_intervals += 1;
            }
            previous_paints = paints;
        }
    }
    mailbox.send(Command::End(input.motion(final_point)));
    wait_rect(
        &fixture,
        (180, 160, 680, 560),
        "final resize point",
        Duration::from_millis(250),
    );
    let paint_deadline = Instant::now() + Duration::from_millis(250);
    loop {
        let mut client = RECT::default();
        unsafe {
            GetClientRect(fixture.hwnd, &mut client).unwrap();
        }
        let painted = fixture.request(GET_PAINTED_SIZE, 0);
        if painted == ((client.right as usize) << 16) | client.bottom as usize {
            break;
        }
        assert!(
            Instant::now() < paint_deadline,
            "client paint did not catch up to its final size"
        );
        thread::sleep(Duration::from_millis(2));
    }
    let mut child_client = RECT::default();
    unsafe {
        let child = GetWindow(fixture.hwnd, GW_CHILD).unwrap();
        GetClientRect(child, &mut child_client).unwrap();
    }
    let child_painted = fixture.request(GET_CHILD_PAINTED_SIZE, 0);
    assert_eq!(
        child_painted,
        ((child_client.right as usize) << 16) | child_client.bottom as usize,
        "child paint did not catch up to its final size"
    );
    eprintln!(
        "client paints={}, resizes={}, child paints={}, child resizes={}, intervals with paint={}/6",
        fixture.request(GET_PAINTS, 0) - initial_paints,
        fixture.request(GET_RESIZES, 0) - initial_resizes,
        fixture.request(GET_CHILD_PAINTS, 0),
        fixture.request(GET_CHILD_RESIZES, 0),
        painting_intervals
    );
    assert!(
        painting_intervals >= 5,
        "client must repaint throughout dragging, not only after release"
    );
}

#[test]
#[ignore = "diagnostic for cross-process SetWindowPos dispatch"]
fn set_window_pos_dispatch_is_synchronous_with_and_without_message_queue() {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let fixture = Fixture::create();
    fixture.reset();
    fixture.request(SET_SLOW, 80);
    let hwnd = fixture.hwnd.0 as usize;
    let no_queue = thread::spawn(move || {
        let hwnd = HWND(hwnd as *mut _);
        let start = Instant::now();
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                190,
                170,
                510,
                410,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
            )
            .unwrap();
        }
        start.elapsed()
    })
    .join()
    .unwrap();
    fixture.request(RESET, 0);
    let with_queue = thread::spawn(move || {
        let hwnd = HWND(hwnd as *mut _);
        unsafe {
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        }
        let start = Instant::now();
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                190,
                170,
                510,
                410,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
            )
            .unwrap();
        }
        start.elapsed()
    })
    .join()
    .unwrap();
    eprintln!("SetWindowPos latency no_queue={no_queue:?} with_queue={with_queue:?}");
}

#[test]
#[ignore = "compares the downloaded AltSnap 1.68 worker on the interactive desktop"]
fn original_altsnap_paints_nested_client_during_resize() {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let fixture = Fixture::create();
    fixture.reset();
    let mut altsnap =
        ProcessCommand::new("C:\\Users\\zq\\AppData\\Local\\Temp\\altsnap-bin-168\\AltSnap.exe")
            .current_dir("C:\\Users\\zq\\AppData\\Local\\Temp\\altsnap-bin-168")
            .creation_flags(0x08000000)
            .spawn()
            .expect("downloaded AltSnap 1.68");
    thread::sleep(Duration::from_millis(800));
    let initial_child_paints = fixture.request(GET_CHILD_PAINTS, 0);
    let mut sampled = 0;
    let mut mismatches = 0;
    let mut previous_expected = 0;
    fixture.grab(430, 350, MOUSEEVENTF_RIGHTDOWN, &[VK_MENU]);
    for i in 1..=120 {
        point_input(430 + i, 350 + i);
        thread::sleep(Duration::from_millis(2));
        let mut child_client = RECT::default();
        unsafe {
            let child = GetWindow(fixture.hwnd, GW_CHILD).unwrap();
            GetClientRect(child, &mut child_client).unwrap();
        }
        let painted = fixture.request(GET_CHILD_PAINTED_SIZE, 0);
        let expected = ((child_client.right as usize) << 16) | child_client.bottom as usize;
        if expected != previous_expected {
            sampled += 1;
            if painted != expected {
                mismatches += 1;
            }
            previous_expected = expected;
        }
    }
    release(true, &[VK_MENU]);
    thread::sleep(Duration::from_millis(250));
    eprintln!(
        "AltSnap 1.68 nested client child paints={}, samples={}, mismatches={}",
        fixture.request(GET_CHILD_PAINTS, 0) - initial_child_paints,
        sampled,
        mismatches
    );
    let _ = altsnap.kill();
    let _ = altsnap.wait();
}

#[test]
#[ignore = "compares production worker client synchronization on the interactive desktop"]
fn production_worker_paints_nested_client_during_resize() {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let fixture = Fixture::create();
    fixture.reset();
    let target = target_at(POINT { x: 430, y: 350 }).expect("fixture target");
    let mailbox = Arc::new(Mailbox::default());
    let worker_mailbox = mailbox.clone();
    let worker_thread = thread::spawn(move || worker::run(worker_mailbox));
    struct WorkerGuard(Arc<Mailbox>, Option<thread::JoinHandle<()>>);
    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            self.0.send(Command::Stop);
            if let Some(thread) = self.1.take() {
                thread.join().unwrap();
            }
        }
    }
    let _worker_guard = WorkerGuard(mailbox.clone(), Some(worker_thread));
    let mut input = InputState::default();
    let origin = POINT { x: 430, y: 350 };
    let edges = ResizeEdges::from_grab_point((origin.x, origin.y), target.rect);
    input.begin(WM_RBUTTONDOWN, origin, edges);
    mailbox.send(Command::Begin {
        target,
        point: origin,
        resize: true,
        edges,
        focus: false,
    });
    let initial_child_paints = fixture.request(GET_CHILD_PAINTS, 0);
    let mut sampled = 0;
    let mut mismatches = 0;
    for i in 1..=120 {
        let point = POINT {
            x: 430 + i,
            y: 350 + i,
        };
        if let Some(motion) = input.move_for_publish_at(point, Instant::now()) {
            mailbox.send(Command::Move(motion));
        }
        thread::sleep(Duration::from_millis(2));
        let mut child_client = RECT::default();
        unsafe {
            let child = GetWindow(fixture.hwnd, GW_CHILD).unwrap();
            GetClientRect(child, &mut child_client).unwrap();
        }
        let painted = fixture.request(GET_CHILD_PAINTED_SIZE, 0);
        let expected = ((child_client.right as usize) << 16) | child_client.bottom as usize;
        sampled += 1;
        if painted != expected {
            mismatches += 1;
        }
    }
    mailbox.send(Command::End(input.motion(POINT { x: 550, y: 470 })));
    thread::sleep(Duration::from_millis(250));
    eprintln!(
        "production nested client parent resizes={}, child paints before={}, child paints after={}, child resizes={}, samples={}, mismatches={}",
        fixture.request(GET_RESIZES, 0),
        initial_child_paints,
        fixture.request(GET_CHILD_PAINTS, 0),
        fixture.request(GET_CHILD_RESIZES, 0),
        sampled,
        mismatches
    );
    assert_eq!(
        mismatches, 0,
        "client must be painted at every sampled resize"
    );
}

#[test]
fn input_move_frame_budget_keeps_latest_point_and_final_point() {
    let origin = POINT { x: 430, y: 360 };
    let t0 = Instant::now();

    let mut move_state = InputState::default();
    move_state.begin(WM_LBUTTONDOWN, origin, ResizeEdges::default());
    let move_reports: Vec<bool> = (1..=6)
        .map(|x| {
            move_state
                .move_for_publish_at(
                    POINT {
                        x: origin.x + x,
                        y: origin.y,
                    },
                    t0 + Duration::from_millis(((x - 1) * 4) as u64),
                )
                .is_some()
        })
        .collect();
    assert_eq!(move_reports, [true, false, false, false, true, false]);

    let mut resize_state = InputState::default();
    let fixed_edges = ResizeEdges {
        x: Some(crate::domain::altsnap::Edge::Far),
        y: Some(crate::domain::altsnap::Edge::Near),
    };
    resize_state.begin(WM_RBUTTONDOWN, origin, fixed_edges);
    let mut duplicate_state = InputState::default();
    duplicate_state.begin(WM_RBUTTONDOWN, origin, fixed_edges);
    assert!(duplicate_state.is_duplicate_move(origin));
    assert!(!duplicate_state.is_duplicate_move(POINT {
        x: origin.x + 1,
        y: origin.y,
    }));
    let resize_reports: Vec<bool> = (1..=8)
        .map(|x| {
            resize_state
                .move_for_publish_at(
                    POINT {
                        x: origin.x + x,
                        y: origin.y,
                    },
                    t0 + Duration::from_millis(((x - 1) * 4) as u64),
                )
                .is_some()
        })
        .collect();
    assert_eq!(
        resize_reports,
        [true, false, false, false, true, false, false, false]
    );

    // A skipped move must not become the terminal geometry: the button-up
    // path calls motion() independently and sends this exact physical point.
    let final_point = POINT { x: 517, y: 389 };
    assert_eq!(resize_state.motion(final_point).point, final_point);
}
