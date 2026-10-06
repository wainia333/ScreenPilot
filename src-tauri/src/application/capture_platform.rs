//! Windows services replacing the upstream Qt/ctypes adapters.
use super::capture_native::Rect;
use image::RgbaImage;
use std::{mem::size_of, path::Path};
use windows::Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*};

pub fn scroll_right() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                mouseData: 120,
                dwFlags: MOUSEEVENTF_HWHEEL,
                ..Default::default()
            },
        },
    };
    if unsafe { SendInput(&[input], size_of::<INPUT>() as i32) } == 1 {
        Ok(())
    } else {
        Err("横向滚动输入未送达".into())
    }
}

pub fn include_cursor(image: &mut RgbaImage, bounds: Rect) -> Result<(), String> {
    unsafe {
        let mut cursor = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        GetCursorInfo(&mut cursor).map_err(|e| e.to_string())?;
        if cursor.flags != CURSOR_SHOWING {
            return Ok(());
        }
        let icon = CopyIcon(HICON(cursor.hCursor.0)).map_err(|e| e.to_string())?;
        let mut info = ICONINFO::default();
        if let Err(error) = GetIconInfo(icon, &mut info) {
            let _ = DestroyIcon(icon);
            return Err(error.to_string());
        }
        let result = (|| {
            let mut bitmap = BITMAP::default();
            let source = if info.hbmColor.is_invalid() {
                info.hbmMask
            } else {
                info.hbmColor
            };
            if GetObjectW(
                source.into(),
                size_of::<BITMAP>() as i32,
                Some((&mut bitmap as *mut BITMAP).cast()),
            ) == 0
            {
                return Err("无法读取鼠标图像".into());
            }
            let width = bitmap.bmWidth.clamp(1, 512) as u32;
            let height = (bitmap.bmHeight / if info.hbmColor.is_invalid() { 2 } else { 1 })
                .clamp(1, 512) as u32;
            let left = cursor.ptScreenPos.x - info.xHotspot as i32 - bounds.x;
            let top = cursor.ptScreenPos.y - info.yHotspot as i32 - bounds.y;
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err("创建鼠标画布失败".into());
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = std::ptr::null_mut();
            let dib = match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut pixels, None, 0) {
                Ok(bitmap) => bitmap,
                Err(error) => {
                    let _ = DeleteDC(dc);
                    return Err(error.to_string());
                }
            };
            let old = SelectObject(dc, dib.into());
            let buffer =
                std::slice::from_raw_parts_mut(pixels.cast::<u8>(), (width * height * 4) as usize);
            for y in 0..height {
                for x in 0..width {
                    let (sx, sy) = (left + x as i32, top + y as i32);
                    let color = if sx >= 0
                        && sy >= 0
                        && sx < image.width() as i32
                        && sy < image.height() as i32
                    {
                        image.get_pixel(sx as u32, sy as u32).0
                    } else {
                        [0, 0, 0, 255]
                    };
                    let at = ((y * width + x) * 4) as usize;
                    buffer[at..at + 4].copy_from_slice(&[color[2], color[1], color[0], 255]);
                }
            }
            let drawn = DrawIconEx(
                dc,
                0,
                0,
                icon,
                width as i32,
                height as i32,
                0,
                None,
                DI_NORMAL,
            );
            let _ = GdiFlush();
            if drawn.is_ok() {
                for y in 0..height {
                    for x in 0..width {
                        let (sx, sy) = (left + x as i32, top + y as i32);
                        if sx >= 0
                            && sy >= 0
                            && sx < image.width() as i32
                            && sy < image.height() as i32
                        {
                            let at = ((y * width + x) * 4) as usize;
                            image.put_pixel(
                                sx as u32,
                                sy as u32,
                                image::Rgba([buffer[at + 2], buffer[at + 1], buffer[at], 255]),
                            );
                        }
                    }
                }
            }
            SelectObject(dc, old);
            let _ = DeleteObject(dib.into());
            let _ = DeleteDC(dc);
            drawn.map_err(|e| e.to_string())
        })();
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
        let _ = DestroyIcon(icon);
        result
    }
}

pub fn append_file_reference(path: &Path) -> Result<(), String> {
    file_reference(path, None)
}
pub fn copy_file(path: &Path, owner: HWND) -> Result<(), String> {
    file_reference(path, Some(owner))
}
fn file_reference(path: &Path, owner: Option<HWND>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::{
        System::{DataExchange::*, Memory::*, Ole::CF_HDROP},
        UI::Shell::DROPFILES,
    };
    let file: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    unsafe {
        // Screenshot append preserves arboard's image formats; GIF copy replaces them.
        let mut opened = false;
        for _ in 0..6 {
            if OpenClipboard(owner).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            return Err("系统剪贴板正忙，无法附加文件引用".into());
        }
        let result = (|| {
            if owner.is_some() {
                EmptyClipboard().map_err(|e| e.to_string())?;
            }
            let memory = GlobalAlloc(
                GMEM_MOVEABLE | GMEM_ZEROINIT,
                size_of::<DROPFILES>() + file.len() * 2,
            )
            .map_err(|e| e.to_string())?;
            let pointer = GlobalLock(memory).cast::<u8>();
            if pointer.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("无法分配剪贴板内存".into());
            }
            pointer.cast::<DROPFILES>().write(DROPFILES {
                pFiles: size_of::<DROPFILES>() as u32,
                fWide: TRUE,
                ..Default::default()
            });
            std::ptr::copy_nonoverlapping(
                file.as_ptr(),
                pointer.add(size_of::<DROPFILES>()).cast(),
                file.len(),
            );
            let _ = GlobalUnlock(memory);
            if let Err(error) = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(memory.0))) {
                let _ = GlobalFree(Some(memory));
                return Err(error.to_string());
            }
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

pub fn move_cursor(dx: i32, dy: i32) -> Result<(i32, i32), String> {
    if dx.unsigned_abs() > 10 || dy.unsigned_abs() > 10 {
        return Err("无效的指针微调".into());
    }
    unsafe {
        let mut p = POINT::default();
        GetCursorPos(&mut p)
            .and_then(|()| SetCursorPos(p.x.saturating_add(dx), p.y.saturating_add(dy)))
            .and_then(|()| GetCursorPos(&mut p))
            .map_err(|e| e.to_string())?;
        Ok((p.x, p.y))
    }
}

pub fn element_at(x: i32, y: i32) -> Option<Rect> {
    use windows::{
        core::Interface,
        Win32::{System::Com::*, UI::Accessibility::*},
    };
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        if let Ok(config) = automation.cast::<IUIAutomation2>() {
            let _ = config.SetConnectionTimeout(100);
            let _ = config.SetTransactionTimeout(100);
        }
        // WindowInfo.id is a list key, not an HWND. Enumerate the real Z-order
        // beneath our capture overlay instead of feeding that key to UIA.
        let current_pid = windows::Win32::System::Threading::GetCurrentProcessId();
        let mut hwnd = GetTopWindow(None).ok()?;
        let mut target = None;
        for _ in 0..1024 {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut r = RECT::default();
            if pid != current_pid
                && IsWindowVisible(hwnd).as_bool()
                && GetWindowRect(hwnd, &mut r).is_ok()
                && r.left <= x
                && x < r.right
                && r.top <= y
                && y < r.bottom
            {
                target = Some(hwnd);
                break;
            }
            hwnd = GetWindow(hwnd, GW_HWNDNEXT).ok()?;
        }
        let mut element = automation.ElementFromHandle(target?).ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let mut found = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
        for _ in 0..24 {
            let mut child = walker.GetFirstChildElement(&element).ok();
            let mut next = None;
            while let Some(candidate) = child {
                if std::time::Instant::now() > deadline {
                    return found;
                }
                if let Ok(r) = candidate.CurrentBoundingRectangle() {
                    if r.left <= x && x < r.right && r.top <= y && y < r.bottom {
                        next = Some(candidate);
                        found = Rect {
                            x: r.left,
                            y: r.top,
                            width: r.right.abs_diff(r.left),
                            height: r.bottom.abs_diff(r.top),
                        }
                        .validate()
                        .ok();
                        break;
                    }
                }
                child = walker.GetNextSiblingElement(&candidate).ok();
            }
            match next {
                Some(next) => element = next,
                None => break,
            }
        }
        found
    }
}
