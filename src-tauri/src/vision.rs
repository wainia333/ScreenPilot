// Vision 模式：枚举屏幕上可见应用窗口（hover 高亮 + 标签）+ 整窗截图。
// macOS：CGWindowListCopyWindowInfo（Quartz）；Windows：Win32 枚举顶层窗口、客户区和子控件。

use serde::{Deserialize, Serialize};

/// 屏幕上一个应用窗口的元信息。坐标为全局逻辑坐标（macOS Quartz：原点左上，含 menubar，跨 monitor 全局）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub owner: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ScreenSpace {
    pub scale: f64,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[cfg(target_os = "macos")]
pub fn list_windows(_screen: Option<ScreenSpace>) -> Vec<WindowInfo> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_graphics::window::{
        kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        CGWindowListCopyWindowInfo,
    };

    let info_ref: CFArrayRef = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };
    if info_ref.is_null() {
        return Vec::new();
    }
    // 数组元素类型为 untyped CFType；每个元素本身是一个 CFDictionary。
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(info_ref) };

    let mut out = Vec::new();
    for item in array.iter() {
        let dict_ref = item.as_CFTypeRef() as CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        let dict: CFDictionary = unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };

        let layer = read_dict_i64(&dict, "kCGWindowLayer").unwrap_or(-1);
        let alpha = read_dict_f64(&dict, "kCGWindowAlpha").unwrap_or(1.0);
        let id = read_dict_i64(&dict, "kCGWindowNumber").unwrap_or(0);
        let owner = read_dict_string(&dict, "kCGWindowOwnerName").unwrap_or_default();
        let title = read_dict_string(&dict, "kCGWindowName").unwrap_or_default();

        let bounds_dict = read_dict_subdict(&dict, "kCGWindowBounds");
        let (bx, by, bw, bh) = if let Some(b) = bounds_dict {
            (
                read_dict_f64(&b, "X").unwrap_or(0.0),
                read_dict_f64(&b, "Y").unwrap_or(0.0),
                read_dict_f64(&b, "Width").unwrap_or(0.0),
                read_dict_f64(&b, "Height").unwrap_or(0.0),
            )
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        let mut reason: Option<&str> = None;
        if id <= 0 {
            reason = Some("no-id");
        } else if layer != 0 {
            reason = Some("layer!=0");
        } else if alpha < 0.05 {
            reason = Some("alpha~0");
        } else if owner == "Kivio" || owner == "kivio" || owner == "KeyLingo" || owner == "keylingo"
        {
            // 同时匹配新名 Kivio 和旧名 KeyLingo —— 旧版本仍在运行的 macOS 实例可能 owner 是 KeyLingo
            reason = Some("self");
        } else if bw < 60.0 || bh < 40.0 {
            reason = Some("too-small");
        }

        if reason.is_some() {
            continue;
        }
        out.push(WindowInfo {
            id: id as u32,
            owner,
            title,
            x: bx,
            y: by,
            width: bw,
            height: bh,
        });
    }
    out
}

#[cfg(target_os = "macos")]
fn read_dict_value(
    dict: &core_foundation::dictionary::CFDictionary,
    key: &str,
) -> Option<core_foundation::base::CFType> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    let cfk = CFString::new(key);
    unsafe {
        let raw = dict.find(cfk.as_CFTypeRef() as *const _);
        raw.map(|r| CFType::wrap_under_get_rule(*r))
    }
}

#[cfg(target_os = "macos")]
fn read_dict_i64(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<i64> {
    use core_foundation::number::CFNumber;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_i64())
}

#[cfg(target_os = "macos")]
fn read_dict_f64(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<f64> {
    use core_foundation::number::CFNumber;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_f64())
}

#[cfg(target_os = "macos")]
fn read_dict_string(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<String> {
    use core_foundation::string::CFString;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFString>())
        .map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn read_dict_subdict(
    dict: &core_foundation::dictionary::CFDictionary,
    key: &str,
) -> Option<core_foundation::dictionary::CFDictionary> {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    let v = read_dict_value(dict, key)?;
    let r = v.as_CFTypeRef() as CFDictionaryRef;
    if r.is_null() {
        return None;
    }
    Some(unsafe { CFDictionary::wrap_under_get_rule(r) })
}

#[cfg(target_os = "windows")]
pub fn list_windows(screen: Option<ScreenSpace>) -> Vec<WindowInfo> {
    use std::collections::{HashMap, HashSet};
    use std::mem::size_of;

    use ::windows::core::{BOOL, PWSTR};
    use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use ::windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use ::windows::Win32::Graphics::Gdi::ClientToScreen;
    use ::windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetClientRect, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GA_ROOT,
    };

    #[derive(Clone)]
    struct NativeRect {
        hwnd: HWND,
        rect: RECT,
        is_window: bool,
    }

    struct EnumState {
        current_pid: u32,
        parent_handles: HashSet<usize>,
        rects: Vec<NativeRect>,
        process_names: HashMap<u32, String>,
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut EnumState);
        check_handle(state, hwnd, true);
        true.into()
    }

    unsafe extern "system" fn enum_child_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut EnumState);
        check_handle(state, hwnd, false);
        true.into()
    }

    unsafe fn check_handle(state: &mut EnumState, hwnd: HWND, is_window: bool) {
        if hwnd.is_invalid() || !IsWindowVisible(hwnd).as_bool() {
            return;
        }
        if is_window && IsIconic(hwnd).as_bool() {
            return;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == state.current_pid {
            return;
        }

        if is_window && is_window_cloaked(hwnd) {
            return;
        }

        let rect = if is_window {
            extended_window_rect(hwnd).or_else(|| window_rect(hwnd))
        } else {
            window_rect(hwnd)
        };
        let Some(rect) = rect else {
            return;
        };
        if !rect_is_valid(rect) {
            return;
        }

        let key = hwnd.0 as usize;
        if state.parent_handles.insert(key) {
            // ShareX 的 WindowsRectangleList 会先递归加入子控件，再加入当前窗口。
            // FirstOrDefault 命中时就能优先选中更深层控件，形成 TrOCR 的丝滑自动选区切换。
            let _ = EnumChildWindows(
                Some(hwnd),
                Some(enum_child_windows_proc),
                LPARAM(state as *mut _ as isize),
            );
        }

        if is_window {
            if let Some(client_rect) = client_rect_screen(hwnd) {
                if rect_is_valid(client_rect) && !same_rect(client_rect, rect) {
                    state.rects.push(NativeRect {
                        hwnd,
                        rect: client_rect,
                        is_window: false,
                    });
                }
            }
        }

        state.rects.push(NativeRect {
            hwnd,
            rect,
            is_window,
        });
    }

    unsafe fn window_rect(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        Some(rect)
    }

    unsafe fn extended_window_rect(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            size_of::<RECT>() as u32,
        )
        .ok()?;
        Some(rect)
    }

    unsafe fn client_rect_screen(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).ok()?;
        let mut top_left = POINT {
            x: rect.left,
            y: rect.top,
        };
        let mut bottom_right = POINT {
            x: rect.right,
            y: rect.bottom,
        };
        if !ClientToScreen(hwnd, &mut top_left).as_bool() {
            return None;
        }
        if !ClientToScreen(hwnd, &mut bottom_right).as_bool() {
            return None;
        }
        Some(RECT {
            left: top_left.x,
            top: top_left.y,
            right: bottom_right.x,
            bottom: bottom_right.y,
        })
    }

    unsafe fn is_window_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
    }

    fn rect_is_valid(rect: RECT) -> bool {
        rect.right > rect.left && rect.bottom > rect.top
    }

    fn same_rect(a: RECT, b: RECT) -> bool {
        a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
    }

    fn rect_contains(outer: RECT, inner: RECT) -> bool {
        outer.left <= inner.left
            && outer.top <= inner.top
            && outer.right >= inner.right
            && outer.bottom >= inner.bottom
    }

    fn rect_intersects_screen(rect: RECT, screen: ScreenSpace) -> bool {
        rect.right > screen.left
            && rect.left < screen.right
            && rect.bottom > screen.top
            && rect.top < screen.bottom
    }

    unsafe fn window_text(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let read = GetWindowTextW(hwnd, &mut buf);
        if read <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..read as usize])
    }

    unsafe fn class_name(hwnd: HWND) -> String {
        let mut buf = vec![0u16; 256];
        let read = GetClassNameW(hwnd, &mut buf);
        if read <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..read as usize])
    }

    unsafe fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid
    }

    unsafe fn process_name(state: &mut EnumState, pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        if let Some(name) = state.process_names.get(&pid) {
            return name.clone();
        }

        let name = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .ok()
            .and_then(|handle| {
                let mut buf = vec![0u16; 32768];
                let mut len = buf.len() as u32;
                let result = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_WIN32,
                    PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
                .ok()
                .map(|_| String::from_utf16_lossy(&buf[..len as usize]));
                let _ = CloseHandle(handle);
                result
            })
            .and_then(|path| {
                std::path::Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
            })
            .unwrap_or_default();

        state.process_names.insert(pid, name.clone());
        name
    }

    let mut state = EnumState {
        current_pid: unsafe { GetCurrentProcessId() },
        parent_handles: HashSet::new(),
        rects: Vec::new(),
        process_names: HashMap::new(),
    };

    let _ = unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut state as *mut _ as isize),
        )
    };

    let mut filtered: Vec<NativeRect> = Vec::new();
    for rect in state.rects.iter().cloned() {
        if !rect.is_window
            && filtered
                .iter()
                .any(|existing| rect_contains(existing.rect, rect.rect))
        {
            continue;
        }
        filtered.push(rect);
    }

    let mut out = Vec::with_capacity(filtered.len());
    let scale = screen
        .map(|screen| screen.scale)
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    for (idx, item) in filtered.into_iter().enumerate() {
        if let Some(screen) = screen {
            if !rect_intersects_screen(item.rect, screen) {
                continue;
            }
        }

        let root = unsafe { GetAncestor(item.hwnd, GA_ROOT) };
        let label_hwnd = if root.is_invalid() { item.hwnd } else { root };
        let pid = unsafe { window_pid(label_hwnd) };
        let title = unsafe { window_text(label_hwnd) };
        let owner = unsafe { process_name(&mut state, pid) };
        let class_name = unsafe { class_name(item.hwnd) };
        let owner = if !owner.is_empty() {
            owner
        } else if !title.is_empty() {
            title.clone()
        } else {
            class_name
        };
        if owner.is_empty() && title.is_empty() {
            continue;
        }

        let width = (item.rect.right - item.rect.left) as f64 / scale;
        let height = (item.rect.bottom - item.rect.top) as f64 / scale;
        if width < 8.0 || height < 8.0 {
            continue;
        }

        out.push(WindowInfo {
            // Windows 上 capture_window 不支持，id 只当前端的列表 key 用（命中后走
            // 区域截图 fallback）。原来的 hwnd^idx 散列既丢了 hwnd 又可能撞号 —— 同一
            // hwnd 会产出 window rect / client rect 两条记录，散列后有概率相等，
            // 撞上就是 React 重复 key + hover 高亮串框。直接用枚举序号，天然唯一。
            id: (idx as u32).wrapping_add(1),
            owner,
            title,
            x: item.rect.left as f64 / scale,
            y: item.rect.top as f64 / scale,
            width,
            height,
        });
    }

    out
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn list_windows(_screen: Option<ScreenSpace>) -> Vec<WindowInfo> {
    Vec::new()
}

/// 单窗口截图（macOS 14+）：走 ScreenCaptureKit (SCScreenshotManager)。
/// 取代旧的 `screencapture -l` CLI 调用：消除几十–几百 ms 子进程冷启动 + 消除屏幕白闪。
#[cfg(target_os = "macos")]
pub fn capture_window(window_id: u32) -> Result<std::path::PathBuf, String> {
    crate::sck::capture_window(window_id)
}

#[cfg(not(target_os = "macos"))]
pub fn capture_window(_window_id: u32) -> Result<std::path::PathBuf, String> {
    Err("Window capture not supported on this platform".to_string())
}
