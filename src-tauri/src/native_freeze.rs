use std::{
    mem::size_of,
    sync::{Mutex, OnceLock},
    time::Instant,
};

use image::RgbaImage;
use tauri::WebviewWindow;
use uuid::Uuid;
use windows::{
    core::w,
    Win32::{
        Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
            EndPaint, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
            BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ, PAINTSTRUCT, SRCCOPY,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos,
            ShowWindow, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_NCDESTROY, WM_PAINT,
            WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        },
    },
};

use crate::vision::ScreenSpace;

const CLASS_NAME: windows::core::PCWSTR = w!("KivioNativeFreezeOverlay");

#[derive(Clone, Copy)]
struct OverlayState {
    hwnd: isize,
    bitmap: isize,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    scale: f64,
}

static OVERLAY: OnceLock<Mutex<Option<OverlayState>>> = OnceLock::new();
static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();

fn overlay_state() -> &'static Mutex<Option<OverlayState>> {
    OVERLAY.get_or_init(|| Mutex::new(None))
}

pub fn is_active() -> bool {
    overlay_state()
        .lock()
        .map(|state| state.is_some())
        .unwrap_or(true)
}

fn hwnd_from_raw(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

fn bitmap_from_raw(raw: isize) -> HBITMAP {
    HBITMAP(raw as *mut _)
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            paint_overlay(hwnd);
            LRESULT(0)
        }
        WM_NCDESTROY => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn paint_overlay(hwnd: HWND) {
    let Ok(guard) = overlay_state().lock() else {
        return;
    };
    let Some(state) = *guard else {
        return;
    };
    if state.hwnd != hwnd.0 as isize {
        return;
    }

    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        if hdc.is_invalid() {
            return;
        }

        let mem_dc = CreateCompatibleDC(Some(hdc));
        if !mem_dc.is_invalid() {
            let old = SelectObject(mem_dc, HGDIOBJ(state.bitmap as *mut _));
            let _ = BitBlt(
                hdc,
                0,
                0,
                state.width,
                state.height,
                Some(mem_dc),
                0,
                0,
                SRCCOPY,
            );
            if !old.is_invalid() {
                let _ = SelectObject(mem_dc, old);
            }
            let _ = DeleteDC(mem_dc);
        }
        let _ = EndPaint(hwnd, &ps);
    }
    drop(guard);
}

fn register_class() -> Result<(), String> {
    if CLASS_REGISTERED.get().is_some() {
        return Ok(());
    }

    unsafe {
        let hinstance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };

        let atom = RegisterClassW(&wc);
        if atom == 0 {
            let err = GetLastError();
            // 1410 = ERROR_CLASS_ALREADY_EXISTS. A previous dev-reload instance can leave the
            // class registered in this process; CreateWindowExW can still use it.
            if err.0 != 1410 {
                return Err(format!("RegisterClassW failed: {err:?}"));
            }
        }
    }

    let _ = CLASS_REGISTERED.set(());
    Ok(())
}

fn capture_screen_bitmap(space: ScreenSpace) -> Result<OverlayState, String> {
    let width = (space.right - space.left).max(1);
    let height = (space.bottom - space.top).max(1);
    let scale = if space.scale.is_finite() && space.scale > 0.0 {
        space.scale
    } else {
        1.0
    };

    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC(NULL) failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC failed".to_string());
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let old = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
        let copied = BitBlt(
            mem_dc,
            0,
            0,
            width,
            height,
            Some(screen_dc),
            space.left,
            space.top,
            SRCCOPY,
        );
        if !old.is_invalid() {
            let _ = SelectObject(mem_dc, old);
        }
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        copied.map_err(|e| {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            format!("BitBlt freeze capture failed: {e}")
        })?;

        Ok(OverlayState {
            hwnd: 0,
            bitmap: bitmap.0 as isize,
            left: space.left,
            top: space.top,
            width,
            height,
            scale,
        })
    }
}

/// Capture the current monitor into a native bitmap and show an opaque Win32 popup behind
/// the transparent Vision WebView. The WebView renders selection UI; this window supplies
/// the frozen desktop frame without routing a giant bitmap through WebView/base64.
pub fn show(space: ScreenSpace) -> Result<(), String> {
    close();
    register_class()?;

    let started = Instant::now();
    let mut state = capture_screen_bitmap(space)?;

    unsafe {
        let hinstance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            CLASS_NAME,
            w!("Kivio Native Freeze"),
            WS_POPUP,
            state.left,
            state.top,
            state.width,
            state.height,
            None,
            None,
            Some(hinstance.into()),
            None,
        )
        .map_err(|e| {
            let _ = DeleteObject(HGDIOBJ(state.bitmap as *mut _));
            format!("CreateWindowExW failed: {e}")
        })?;

        state.hwnd = hwnd.0 as isize;
        {
            let mut guard = overlay_state()
                .lock()
                .map_err(|_| "native freeze overlay lock poisoned".to_string())?;
            *guard = Some(state);
        }

        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            state.left,
            state.top,
            state.width,
            state.height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    eprintln!(
        "[vision-freeze] native GDI overlay ready in {}ms",
        started.elapsed().as_millis()
    );
    Ok(())
}

pub fn place_vision_above(window: &WebviewWindow) {
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
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

pub fn close() {
    let state = overlay_state()
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let Some(state) = state else {
        return;
    };

    unsafe {
        let hwnd = hwnd_from_raw(state.hwnd);
        if !hwnd.0.is_null() {
            let _ = DestroyWindow(hwnd);
        }
        let bitmap = bitmap_from_raw(state.bitmap);
        if !bitmap.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
        }
    }
}

pub fn capture_active_region_to_png(
    absolute_x: i32,
    absolute_y: i32,
    width: u32,
    height: u32,
) -> Result<std::path::PathBuf, String> {
    let guard = overlay_state()
        .lock()
        .map_err(|_| "native freeze overlay lock poisoned".to_string())?;
    let state = (*guard).ok_or_else(|| "native freeze overlay is not active".to_string())?;

    let crop_w = ((width as f64) * state.scale).round().max(1.0) as i32;
    let crop_h = ((height as f64) * state.scale).round().max(1.0) as i32;
    let crop_x = ((absolute_x as f64) * state.scale).round() as i32 - state.left;
    let crop_y = ((absolute_y as f64) * state.scale).round() as i32 - state.top;

    if crop_x < 0
        || crop_y < 0
        || crop_w <= 0
        || crop_h <= 0
        || crop_x >= state.width
        || crop_y >= state.height
    {
        return Err("native freeze crop region is outside overlay".to_string());
    }

    let crop_w = crop_w.min(state.width.saturating_sub(crop_x));
    let crop_h = crop_h.min(state.height.saturating_sub(crop_y));
    let pixels = unsafe { crop_bitmap_to_rgba(state, crop_x, crop_y, crop_w, crop_h)? };
    drop(guard);
    let image = RgbaImage::from_raw(crop_w as u32, crop_h as u32, pixels)
        .ok_or_else(|| "failed to build cropped RGBA image".to_string())?;
    let temp_path = std::env::temp_dir().join(format!("screenshot-{}.png", Uuid::new_v4()));
    image.save(&temp_path).map_err(|e| e.to_string())?;
    Ok(temp_path)
}

unsafe fn crop_bitmap_to_rgba(
    state: OverlayState,
    crop_x: i32,
    crop_y: i32,
    crop_w: i32,
    crop_h: i32,
) -> Result<Vec<u8>, String> {
    let screen_dc = GetDC(None);
    if screen_dc.is_invalid() {
        return Err("GetDC(NULL) failed for crop".to_string());
    }

    let src_dc = CreateCompatibleDC(Some(screen_dc));
    let crop_dc = CreateCompatibleDC(Some(screen_dc));
    if src_dc.is_invalid() || crop_dc.is_invalid() {
        if !src_dc.is_invalid() {
            let _ = DeleteDC(src_dc);
        }
        if !crop_dc.is_invalid() {
            let _ = DeleteDC(crop_dc);
        }
        let _ = ReleaseDC(None, screen_dc);
        return Err("CreateCompatibleDC failed for crop".to_string());
    }

    let crop_bitmap = CreateCompatibleBitmap(screen_dc, crop_w, crop_h);
    if crop_bitmap.is_invalid() {
        let _ = DeleteDC(src_dc);
        let _ = DeleteDC(crop_dc);
        let _ = ReleaseDC(None, screen_dc);
        return Err("CreateCompatibleBitmap failed for crop".to_string());
    }

    let old_src = SelectObject(src_dc, HGDIOBJ(state.bitmap as *mut _));
    let old_crop = SelectObject(crop_dc, HGDIOBJ(crop_bitmap.0));
    let copied = BitBlt(
        crop_dc,
        0,
        0,
        crop_w,
        crop_h,
        Some(src_dc),
        crop_x,
        crop_y,
        SRCCOPY,
    );

    if let Err(err) = copied {
        if !old_src.is_invalid() {
            let _ = SelectObject(src_dc, old_src);
        }
        if !old_crop.is_invalid() {
            let _ = SelectObject(crop_dc, old_crop);
        }
        let _ = DeleteObject(HGDIOBJ(crop_bitmap.0));
        let _ = DeleteDC(src_dc);
        let _ = DeleteDC(crop_dc);
        let _ = ReleaseDC(None, screen_dc);
        return Err(format!("BitBlt crop failed: {err}"));
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: crop_w,
            biHeight: -crop_h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (crop_w as usize) * (crop_h as usize) * 4];
    let lines = GetDIBits(
        crop_dc,
        crop_bitmap,
        0,
        crop_h as u32,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut info,
        DIB_RGB_COLORS,
    );

    if !old_src.is_invalid() {
        let _ = SelectObject(src_dc, old_src);
    }
    if !old_crop.is_invalid() {
        let _ = SelectObject(crop_dc, old_crop);
    }
    let _ = DeleteObject(HGDIOBJ(crop_bitmap.0));
    let _ = DeleteDC(src_dc);
    let _ = DeleteDC(crop_dc);
    let _ = ReleaseDC(None, screen_dc);

    if lines == 0 {
        return Err("GetDIBits failed for crop".to_string());
    }

    // GetDIBits returns BGRA for 32-bit BI_RGB. Convert to RGBA for the image crate.
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    Ok(pixels)
}
