use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, SetWindowTextW,
};

struct OverlayWindow {
    process_id: u32,
    rect: RECT,
}

unsafe extern "system" fn apply_title(hwnd: HWND, parameter: LPARAM) -> BOOL {
    let target = &*(parameter.0 as *const OverlayWindow);
    let mut process_id = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    if process_id != target.process_id || !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_ok()
        && rect.left == target.rect.left
        && rect.top == target.rect.top
        && rect.right == target.rect.right
        && rect.bottom == target.rect.bottom
    {
        let _ = SetWindowTextW(hwnd, w!("ScreenPilot Native Freeze"));
    }
    true.into()
}

pub fn apply(left: i32, top: i32, right: i32, bottom: i32) {
    let target = OverlayWindow {
        process_id: std::process::id(),
        rect: RECT {
            left,
            top,
            right,
            bottom,
        },
    };
    let _ = unsafe {
        EnumWindows(
            Some(apply_title),
            LPARAM(&target as *const OverlayWindow as isize),
        )
    };
}
