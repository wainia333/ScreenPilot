//! In-process native capture, input, recorder and image-stitch primitives.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{io::Cursor, path::Path};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

// Live screen tests share one desktop and overlapping fixture coordinates.
// Keep visible fixtures from covering another test's expected pixels.
#[cfg(test)]
pub(super) static DESKTOP_CAPTURE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn validate(self) -> Result<Self, String> {
        if self.width == 0
            || self.height == 0
            || self.width > 32768
            || self.height > 32768
            || u64::from(self.width) * u64::from(self.height) > 100_000_000
        {
            return Err("截图区域尺寸无效或过大".into());
        }
        if self.x.checked_add(self.width as i32).is_none()
            || self.y.checked_add(self.height as i32).is_none()
        {
            return Err("截图坐标超出范围".into());
        }
        Ok(self)
    }
}
pub fn desktop_rect() -> Result<Rect, String> {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(0) as u32,
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(0) as u32,
        }
        .validate()
    }
}
pub fn capture(rect: Rect, engine: &str) -> Result<RgbaImage, String> {
    let rect = rect.validate()?;
    if engine != "mss" {
        let hdr = hdrcapture::hdr_capture::Capture::with_timeout(400).and_then(|mut capture| {
            capture.grab_region(
                hdrcapture::hdr_capture::display::Rect::new(
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                ),
                400,
                hdrcapture::hdr_capture::ToneMapping::default(),
            )
        });
        match hdr {
            Ok(frame) => return bgra(frame.bgra, frame.width, frame.height),
            Err(error) if engine == "hdr" => return Err(format!("HDR 截屏失败：{error}")),
            Err(_) => {}
        }
    }
    let mut capture = gifrecorder::capture::ScreenCapture::new(
        rect.x,
        rect.y,
        rect.width as i32,
        rect.height as i32,
    )?;
    bgra(capture.grab()?.to_vec(), rect.width, rect.height)
}
fn bgra(mut bytes: Vec<u8>, width: u32, height: u32) -> Result<RgbaImage, String> {
    for pixel in bytes.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    RgbaImage::from_raw(width, height, bytes).ok_or_else(|| "截图像素尺寸不匹配".into())
}
pub fn png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
}
pub fn data_url(image: &RgbaImage) -> Result<String, String> {
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png(image)?)
    ))
}
pub fn scan(image: RgbaImage) -> Vec<serde_json::Value> {
    let gray = image::DynamicImage::ImageRgba8(image).into_luma8();
    rxing::helpers::detect_multiple_in_luma(gray.as_raw().to_vec(), gray.width(), gray.height())
        .unwrap_or_default().iter().map(|result| serde_json::json!({"text":result.getText(),"format":format!("{:?}",result.getBarcodeFormat())})).collect()
}
pub fn decode(data: &str) -> Result<RgbaImage, String> {
    if data.len() > 160_000_000 {
        return Err("图片数据过大".into());
    }
    let bytes = STANDARD
        .decode(
            data.strip_prefix("data:image/png;base64,")
                .ok_or("只接受 PNG 图片")?,
        )
        .map_err(|e| e.to_string())?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(400_000_000);
    reader.limits(limits);
    Ok(reader.decode().map_err(|e| e.to_string())?.into_rgba8())
}
pub fn save(image: &RgbaImage, path: &Path, quality: u8) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let mut buffer = Cursor::new(Vec::new());
    match extension.as_str() {
        "jpg" | "jpeg" => {
            let mut rgb = image::RgbImage::new(image.width(), image.height());
            for (dst, src) in rgb.pixels_mut().zip(image.pixels()) {
                for channel in 0..3 {
                    dst[channel] = ((u16::from(src[channel]) * u16::from(src[3])
                        + 255 * (255 - u16::from(src[3])))
                        / 255) as u8;
                }
            }
            // UI quality 0 means the lowest quality supported by the JPEG encoder.
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality.clamp(1, 100))
                .encode_image(&DynamicImage::ImageRgb8(rgb))
                .map_err(|e| e.to_string())?;
        }
        "pdf" => {
            buffer = Cursor::new(pdf(image)?);
        }
        "png" | "bmp" | "webp" => image
            .write_to(
                &mut buffer,
                image::ImageFormat::from_extension(extension).ok_or("不支持的图片格式")?,
            )
            .map_err(|e| e.to_string())?,
        _ => return Err("不支持的图片格式".into()),
    }
    atomic_write(path, &buffer.into_inner())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("文件路径无效")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temp = directory.join(format!(".screenpilot-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
pub fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|e| e.to_string())
    }
}
fn pdf(image: &RgbaImage) -> Result<Vec<u8>, String> {
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;

    // PDF image streams retain original RGB bytes; an optional soft mask retains alpha.
    // Encode by rows to avoid allocating a second full-size uncompressed bitmap.
    let (w, h) = (image.width(), image.height());
    if w == 0 || h == 0 {
        return Err("PDF 图片尺寸无效".into());
    }
    let mut rgb = ZlibEncoder::new(Vec::new(), Compression::default());
    let mut alpha = image
        .pixels()
        .any(|pixel| pixel[3] != 255)
        .then(|| ZlibEncoder::new(Vec::new(), Compression::default()));
    let mut colors = Vec::with_capacity(w as usize * 3);
    let mut opacity = Vec::with_capacity(w as usize);
    for row in image.rows() {
        colors.clear();
        opacity.clear();
        for pixel in row {
            colors.extend_from_slice(&pixel.0[..3]);
            if alpha.is_some() {
                opacity.push(pixel[3]);
            }
        }
        rgb.write_all(&colors).map_err(|e| e.to_string())?;
        if let Some(encoder) = &mut alpha {
            encoder.write_all(&opacity).map_err(|e| e.to_string())?;
        }
    }
    let rgb = rgb.finish().map_err(|e| e.to_string())?;
    let alpha = alpha
        .map(|encoder| encoder.finish().map_err(|e| e.to_string()))
        .transpose()?;
    // Keep long screenshots within PDF's 14,400-unit page limit without resampling.
    let unit = (f64::from(w.max(h)) / 14_400.0).ceil().max(1.0);
    let page_width = f64::from(w) / unit;
    let page_height = f64::from(h) / unit;
    let content = format!("q {page_width} 0 0 {page_height} 0 0 cm /I Do Q");
    let mut out = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![0];
    let mut object = |id: usize, bytes: &[u8]| {
        offsets.push(out.len());
        out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        out.extend_from_slice(bytes);
        out.extend_from_slice(b"\nendobj\n");
    };
    object(1, b"<< /Type /Catalog /Pages 2 0 R >>");
    object(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width} {page_height}] /UserUnit {unit} /Resources << /XObject << /I 4 0 R >> >> /Contents 5 0 R >>").as_bytes());
    let mask = if alpha.is_some() { " /SMask 6 0 R" } else { "" };
    object(4, &pdf_stream(&format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode{mask}"), &rgb));
    object(
        5,
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        )
        .as_bytes(),
    );
    if let Some(alpha) = alpha {
        object(6, &pdf_stream(&format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode"), &alpha));
    }
    let xref = out.len();
    let count = offsets.len();
    out.extend(format!("xref\n0 {count}\n0000000000 65535 f \n").as_bytes());
    for offset in offsets.iter().skip(1) {
        out.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!("trailer << /Size {count} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    Ok(out)
}
fn pdf_stream(dictionary: &str, bytes: &[u8]) -> Vec<u8> {
    let mut stream = format!("<< {dictionary} /Length {} >>\nstream\n", bytes.len()).into_bytes();
    stream.extend_from_slice(bytes);
    stream.extend_from_slice(b"\nendstream");
    stream
}
pub fn copy_image(image: &RgbaImage) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    for attempt in 0..6 {
        let result = clipboard.set_image(arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: std::borrow::Cow::Borrowed(image.as_raw()),
        });
        match result {
            Ok(()) => return Ok(()),
            Err(error) if attempt == 5 => return Err(format!("系统剪贴板正忙：{error}")),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(30)),
        }
    }
    Err("无法复制图片".into())
}
pub fn set_hit_regions(window: &tauri::WebviewWindow, rects: &[Rect]) -> Result<(), String> {
    set_hwnd_hit_regions(window.hwnd().map_err(|e| e.to_string())?, rects)
}
pub(super) fn set_hwnd_hit_regions(
    handle: windows::Win32::Foundation::HWND,
    rects: &[Rect],
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR},
    };
    if rects.len() > 64 {
        return Err("交互区域过多".into());
    }
    for rect in rects {
        rect.validate()?;
    }
    unsafe {
        let region = CreateRectRgn(0, 0, 0, 0);
        for rect in rects {
            let item = CreateRectRgn(
                rect.x,
                rect.y,
                rect.x + rect.width as i32,
                rect.y + rect.height as i32,
            );
            let _ = CombineRgn(Some(region), Some(region), Some(item), RGN_OR);
            let _ = DeleteObject(item.into());
        }
        // The transparent WebView already paints its canvases. Asking Windows to
        // erase/redraw the whole shaped window can flash the live selection.
        if SetWindowRgn(HWND(handle.0), Some(region), false) == 0 {
            let _ = DeleteObject(region.into());
            return Err("设置浮窗区域失败".into());
        }
    }
    Ok(())
}
pub fn clear_hit_regions(window: &tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|e| e.to_string())?;
    if unsafe { windows::Win32::Graphics::Gdi::SetWindowRgn(handle, None, true) } == 0 {
        return Err("恢复截图窗口区域失败".into());
    }
    Ok(())
}
/// Tao keeps WS_CAPTION even on an undecorated window and removes its client
/// insets in WM_NCCALCSIZE. A shaped transparent host can still have that caption
/// painted by Windows on activation/style changes. Keep pin hosts truly frameless
/// before any framework update reaches the compositor.
pub fn prepare_pin_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    pin_window_update(window, |window| {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        prepare_pin_host_hwnd(hwnd)
    })
}
fn prepare_pin_host_hwnd(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    unsafe {
        use windows::Win32::{UI::Shell::SetWindowSubclass, UI::WindowsAndMessaging::*};
        if !SetWindowSubclass(hwnd, Some(pin_host_proc), PIN_HOST_SUBCLASS, 0).as_bool() {
            return Err("无法初始化钉图交互窗口".into());
        }
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        SetWindowLongW(
            hwnd,
            GWL_STYLE,
            (style & !(WS_CAPTION.0 | WS_THICKFRAME.0)) as i32,
        );
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
const PIN_HOST_SUBCLASS: usize = 0x5350_5049;
unsafe extern "system" fn pin_host_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{
        UI::Shell::{DefSubclassProc, RemoveWindowSubclass},
        UI::WindowsAndMessaging::*,
    };
    if message == WM_NCPAINT {
        return windows::Win32::Foundation::LRESULT(0);
    }
    if message == WM_NCACTIVATE {
        return windows::Win32::Foundation::LRESULT(1);
    }
    if message == WM_STYLECHANGING && wparam.0 as i32 == GWL_STYLE.0 {
        let styles = &mut *(lparam.0 as *mut STYLESTRUCT);
        styles.styleNew &= !(WS_CAPTION.0 | WS_THICKFRAME.0);
    }
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(pin_host_proc), id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}
pub fn set_pin_visibility(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    pin_window_update(window, move |window| {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        super::lifecycle::disable_capture_window_transitions(hwnd)?;
        // Tao must know the same visibility as the HWND. Otherwise its next
        // style update (e.g. pointer passthrough) reapplies SW_HIDE to the pin.
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|e| e.to_string())?;
        set_pin_hwnd_visibility(hwnd, visible)
    })
}
fn pin_window_update(
    window: &tauri::WebviewWindow,
    update: impl FnOnce(&tauri::WebviewWindow) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let target = window.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(update(&target));
        })
        .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "钉图窗口更新超时".to_string())?
}
pub fn retain_pin_selection(
    window: &tauri::WebviewWindow,
    cover: windows::Win32::Foundation::HWND,
    selection: Rect,
) -> Result<(), String> {
    let source = window.hwnd().map_err(|e| e.to_string())?;
    // The pixels are an independent surface for the pin's entire lifetime.
    // Changing popup owners ties their compositor transitions to both hosts.
    let _ = cover;
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    // Keep the original selected surface continuously present underneath the
    // cover. Only controls and pixels OUTSIDE the selection are withdrawn.
    set_hwnd_hit_regions(
        source,
        &[Rect {
            x: selection.x - origin.x,
            y: selection.y - origin.y,
            ..selection
        }],
    )
}
pub fn prepare_pin_visibility(
    window: &tauri::WebviewWindow,
    source: &tauri::WebviewWindow,
    cover: Option<windows::Win32::Foundation::HWND>,
) -> Result<(), String> {
    let source = source.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let cover = cover.map(|hwnd| hwnd.0 as isize);
    let target = window.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |view| {
            use windows::Win32::Foundation::HWND;
            let result = (|| {
                let hwnd = target.hwnd().map_err(|e| e.to_string())?;
                let cover = cover.map(|raw| HWND(raw as *mut _));
                // Commit the empty native host before exposing Chromium's controls.
                // The independent pixel surface is never shown/hidden/reparented here.
                unsafe {
                    view.controller()
                        .SetIsVisible(false)
                        .map_err(|e| e.to_string())?;
                }
                let shown = target.show().map_err(|e| e.to_string()).and_then(|()| {
                    prepare_pin_hwnd_visibility(hwnd, HWND(source as *mut _), cover)
                });
                unsafe {
                    view.controller()
                        .SetIsVisible(true)
                        .map_err(|e| e.to_string())?;
                }
                shown
            })();
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "钉图交互窗口显示超时".to_string())?
}
fn prepare_pin_hwnd_visibility(
    hwnd: windows::Win32::Foundation::HWND,
    source: windows::Win32::Foundation::HWND,
    cover: Option<windows::Win32::Foundation::HWND>,
) -> Result<(), String> {
    use windows::Win32::{
        Graphics::Dwm::DwmFlush,
        UI::WindowsAndMessaging::{
            IsWindowVisible, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_SHOWWINDOW,
        },
    };
    super::lifecycle::disable_capture_window_transitions(hwnd)?;
    if !unsafe { IsWindowVisible(cover.unwrap_or(source)).as_bool() } {
        return Err("原选区已隐藏，钉图交接已取消".into());
    }
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|e| e.to_string())?;
        if let Some(cover) = cover {
            SetWindowPos(
                cover,
                Some(hwnd),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .map_err(|e| e.to_string())?;
        }
        DwmFlush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn set_pin_hwnd_visibility(
    hwnd: windows::Win32::Foundation::HWND,
    visible: bool,
) -> Result<(), String> {
    use windows::Win32::{
        Graphics::Dwm::DwmFlush,
        UI::WindowsAndMessaging::{
            SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SWP_SHOWWINDOW,
        },
    };
    super::lifecycle::disable_capture_window_transitions(hwnd)?;
    // Update visibility directly, with neither AnimateWindow nor a framework
    // show/hide transition. The image's configured opacity is left unchanged.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE
                | SWP_NOSIZE
                | SWP_NOZORDER
                | SWP_NOACTIVATE
                | if visible {
                    SWP_SHOWWINDOW
                } else {
                    SWP_HIDEWINDOW
                },
        )
        .map_err(|e| e.to_string())?;
        DwmFlush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn allow_recording_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_NONE,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_NONE)
            .map_err(|e| format!("无法关闭实时采集窗口内容保护：{e}"))?;
        let mut affinity = 0;
        GetWindowDisplayAffinity(hwnd, &mut affinity).map_err(|e| e.to_string())?;
        if affinity != WDA_NONE.0 {
            return Err("实时采集窗口仍受内容保护，已中止以避免黑屏".into());
        }
        windows::Win32::Graphics::Dwm::DwmFlush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read the compositor's existing selected pixels without hiding/repainting the
/// source. The source remains protected after the retained surface is on screen.
pub fn with_readable_pin_source<T>(
    window: &tauri::WebviewWindow,
    retain: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    with_readable_pin_hwnd(hwnd, retain)
}
fn with_readable_pin_hwnd<T>(
    hwnd: windows::Win32::Foundation::HWND,
    retain: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use windows::Win32::{Graphics::Dwm::DwmFlush, UI::WindowsAndMessaging::*};
    unsafe {
        let mut affinity = 0;
        GetWindowDisplayAffinity(hwnd, &mut affinity).map_err(|e| e.to_string())?;
        if affinity == WDA_NONE.0 {
            return retain();
        }
        SetWindowDisplayAffinity(hwnd, WDA_NONE).map_err(|e| e.to_string())?;
        let result = DwmFlush()
            .map_err(|e| e.to_string())
            .and_then(|()| retain());
        let restored = SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(affinity))
            .map_err(|e| e.to_string());
        restored?;
        result
    }
}

struct OwnedRegion(windows::Win32::Graphics::Gdi::HRGN);
impl OwnedRegion {
    fn empty() -> Result<Self, String> {
        let region = unsafe { windows::Win32::Graphics::Gdi::CreateRectRgn(0, 0, 0, 0) };
        if region.is_invalid() {
            return Err("无法创建截图窗口区域".into());
        }
        Ok(Self(region))
    }
    fn apply(self, hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
        if unsafe { windows::Win32::Graphics::Gdi::SetWindowRgn(hwnd, Some(self.0), false) } == 0 {
            return Err("无法更新长截图窗口区域".into());
        }
        // SetWindowRgn transfers ownership to Windows on success only.
        std::mem::forget(self);
        Ok(())
    }
}
impl Drop for OwnedRegion {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(self.0.into());
        }
    }
}

pub fn capture_through_region<T>(
    window: &tauri::WebviewWindow,
    rect: Rect,
    capture: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    capture_through_hwnd(window.hwnd().map_err(|e| e.to_string())?, rect, capture)
}

fn capture_through_hwnd<T>(
    hwnd: windows::Win32::Foundation::HWND,
    rect: Rect,
    capture: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use windows::Win32::Graphics::{
        Dwm::DwmFlush,
        Gdi::{CombineRgn, CreateRectRgn, EqualRgn, GetWindowRgn, RGN_DIFF},
    };
    let rect = rect.validate()?;
    let original = OwnedRegion::empty()?;
    if unsafe { GetWindowRgn(hwnd, original.0) }.0 == 0 {
        return Err("长截图窗口区域尚未就绪".into());
    }
    let hole = OwnedRegion(unsafe {
        CreateRectRgn(
            rect.x,
            rect.y,
            rect.x + rect.width as i32,
            rect.y + rect.height as i32,
        )
    });
    if hole.0.is_invalid() {
        return Err("无法创建长截图选区".into());
    }
    let sampling = OwnedRegion::empty()?;
    if unsafe { CombineRgn(Some(sampling.0), Some(original.0), Some(hole.0), RGN_DIFF) }.0 == 0 {
        return Err("无法排除长截图控件".into());
    }
    if unsafe { EqualRgn(original.0, sampling.0) }.as_bool() {
        // Normally all UI is outside the selection: zero window mutations.
        return capture();
    }
    sampling.apply(hwnd)?;
    let result = unsafe { DwmFlush() }
        .map_err(|e| e.to_string())
        .and_then(|()| capture());
    // Restore on capture failure too. No show/hide, focus or opacity transition.
    original.apply(hwnd)?;
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pin_host_stays_frameless_when_framework_rewrites_styles() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("Pin host fixture"),
                WS_POPUP | WS_CAPTION,
                -32000,
                -32000,
                100,
                80,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            prepare_pin_host_hwnd(hwnd).unwrap();
            for _ in 0..3 {
                let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
                SetWindowLongW(
                    hwnd,
                    GWL_STYLE,
                    (style | WS_CAPTION.0 | WS_THICKFRAME.0) as i32,
                );
                assert_eq!(
                    GetWindowLongW(hwnd, GWL_STYLE) as u32 & (WS_CAPTION.0 | WS_THICKFRAME.0),
                    0
                );
                assert_eq!(
                    SendMessageW(
                        hwnd,
                        WM_NCACTIVATE,
                        Some(windows::Win32::Foundation::WPARAM(1)),
                        None
                    )
                    .0,
                    1
                );
                assert!(!IsWindowVisible(hwnd).as_bool());
            }
            DestroyWindow(hwnd).unwrap();
        }
    }
    #[test]
    fn pin_source_sampling_restores_protection_after_success_and_failure() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("Protected pin source fixture"),
                WS_POPUP,
                -32000,
                -32000,
                100,
                80,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).unwrap();
            for success in [true, false] {
                let result = with_readable_pin_hwnd(hwnd, || {
                    let mut affinity = 0;
                    GetWindowDisplayAffinity(hwnd, &mut affinity).unwrap();
                    assert_eq!(affinity, WDA_NONE.0);
                    if success {
                        Ok(())
                    } else {
                        Err("capture failed".to_string())
                    }
                });
                assert_eq!(result.is_ok(), success);
                let mut affinity = 0;
                GetWindowDisplayAffinity(hwnd, &mut affinity).unwrap();
                assert_eq!(affinity, WDA_EXCLUDEFROMCAPTURE.0);
            }
            DestroyWindow(hwnd).unwrap();
        }
    }
    #[test]
    fn narrowing_capture_to_selection_keeps_same_visible_window_and_origin() {
        use windows::{
            core::w,
            Win32::{
                Foundation::RECT,
                Graphics::Gdi::{CreateRectRgn, DeleteObject, EqualRgn, GetWindowRgn},
                UI::WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, GetWindowRect, IsWindowVisible,
                    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
                },
            },
        };
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("ScreenPilot retained selection"),
                WS_POPUP,
                -32000,
                -32000,
                640,
                400,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            set_pin_hwnd_visibility(hwnd, true).unwrap();
            let mut before = RECT::default();
            GetWindowRect(hwnd, &mut before).unwrap();
            let selection = Rect {
                x: 80,
                y: 60,
                width: 320,
                height: 240,
            };
            set_hwnd_hit_regions(hwnd, &[selection]).unwrap();
            assert!(IsWindowVisible(hwnd).as_bool());
            let mut after = RECT::default();
            GetWindowRect(hwnd, &mut after).unwrap();
            assert_eq!(
                (before.left, before.top, before.right, before.bottom),
                (after.left, after.top, after.right, after.bottom)
            );
            let actual = CreateRectRgn(0, 0, 0, 0);
            let expected = CreateRectRgn(80, 60, 400, 300);
            assert_ne!(GetWindowRgn(hwnd, actual).0, 0);
            assert!(EqualRgn(actual, expected).as_bool());
            let _ = DeleteObject(actual.into());
            let _ = DeleteObject(expected.into());
            DestroyWindow(hwnd).unwrap();
        }
    }
    #[test]
    fn pin_preparation_keeps_selection_visible_under_replacement_without_changing_focus() {
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindow, IsWindowVisible,
                SetWindowPos, GW_HWNDNEXT, GW_OWNER, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
                SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
            },
        };
        unsafe {
            let foreground = GetForegroundWindow();
            let create = || {
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    w!("STATIC"),
                    w!("ScreenPilot pin handoff fixture"),
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
                .unwrap()
            };
            let source = create();
            let pin = create();
            set_pin_hwnd_visibility(source, true).unwrap();
            prepare_pin_hwnd_visibility(pin, source, None).unwrap();
            assert!(IsWindowVisible(source).as_bool());
            assert!(IsWindowVisible(pin).as_bool());
            // Other topmost windows (IME/cursor overlays) can sit between the
            // fixtures. Verify relative ordering, not global adjacency.
            let mut next = pin;
            let mut found = false;
            for _ in 0..1024 {
                let Ok(below) = GetWindow(next, GW_HWNDNEXT) else {
                    break;
                };
                if below.0.is_null() {
                    break;
                }
                if below == source {
                    found = true;
                    break;
                }
                next = below;
            }
            assert!(
                found,
                "original selected pixels must stay underneath the pin"
            );
            assert_eq!(GetForegroundWindow(), foreground);
            let cover = create();
            set_pin_hwnd_visibility(cover, true).unwrap();
            set_hwnd_hit_regions(
                source,
                &[Rect {
                    x: 1,
                    y: 1,
                    width: 8,
                    height: 8,
                }],
            )
            .unwrap();
            assert!(IsWindowVisible(source).as_bool());
            assert!(IsWindowVisible(cover).as_bool());
            prepare_pin_hwnd_visibility(pin, source, Some(cover)).unwrap();
            assert!(GetWindow(cover, GW_OWNER).unwrap_or_default().0.is_null());
            // Transparent controls may rise; their independent pixels cannot
            // inherit a host transition or disappear when either host is hidden.
            SetWindowPos(
                pin,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .unwrap();
            let mut next = pin;
            let mut found = false;
            for _ in 0..1024 {
                let Ok(below) = GetWindow(next, GW_HWNDNEXT) else {
                    break;
                };
                if below == cover {
                    found = true;
                    break;
                }
                if below.0.is_null() {
                    break;
                }
                next = below;
            }
            assert!(
                found,
                "pixels must stay immediately under transparent controls"
            );
            set_pin_hwnd_visibility(source, false).unwrap();
            assert!(IsWindowVisible(pin).as_bool());
            assert!(IsWindowVisible(cover).as_bool());
            // Destroying either host cannot destroy the independent pixels.
            set_pin_hwnd_visibility(source, true).unwrap();
            DestroyWindow(pin).unwrap();
            assert!(IsWindowVisible(cover).as_bool());
            DestroyWindow(cover).unwrap();
            DestroyWindow(source).unwrap();
        }
    }
    #[test]
    fn pin_visibility_changes_immediately_without_dwm_transitions_or_focus_change() {
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetForegroundWindow, IsWindowVisible,
                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
            },
        };
        unsafe {
            let foreground = GetForegroundWindow();
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("ScreenPilot instant pin fixture"),
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
            .unwrap();
            for visible in [true, false, true, false] {
                set_pin_hwnd_visibility(hwnd, visible).unwrap();
                assert_eq!(IsWindowVisible(hwnd).as_bool(), visible);
                // DWMWA_TRANSITIONS_FORCEDISABLED is a set-only attribute.
                // The helper must successfully set it on every visibility change.
                assert_eq!(GetForegroundWindow(), foreground);
            }
            DestroyWindow(hwnd).unwrap();
        }
    }
    #[test]
    fn live_capture_hole_keeps_border_visible_and_restores_overlapping_controls_on_error() {
        let _desktop = DESKTOP_CAPTURE_TEST_LOCK.lock().unwrap();
        use windows::{
            core::w,
            Win32::{
                Foundation::{COLORREF, HWND, RECT},
                Graphics::{
                    Dwm::DwmFlush,
                    Gdi::{
                        CombineRgn, CreateSolidBrush, DeleteObject, EqualRgn, FillRect, GetDC,
                        GetWindowRgn, ReleaseDC, UpdateWindow, RGN_DIFF,
                    },
                },
                UI::HiDpi::{
                    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                },
                UI::WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, GetForegroundWindow, IsWindowVisible,
                    WINDOW_STYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
                    WS_VISIBLE,
                },
            },
        };
        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        struct DpiContext(DPI_AWARENESS_CONTEXT);
        impl Drop for DpiContext {
            fn drop(&mut self) {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
        unsafe {
            let _dpi = DpiContext(SetThreadDpiAwarenessContext(
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            ));
            // Built-in STATIC styles 6/4 paint solid white/black without an app
            // message loop. The small isolated windows never take input focus.
            let base = TestWindow(
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    w!("STATIC"),
                    w!("Scroll capture white fixture"),
                    WINDOW_STYLE(WS_POPUP.0 | WS_VISIBLE.0 | 6),
                    80,
                    80,
                    192,
                    128,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            let overlay = TestWindow(
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    w!("STATIC"),
                    w!("Scroll capture overlay fixture"),
                    WINDOW_STYLE(WS_POPUP.0 | WS_VISIBLE.0 | 4),
                    80,
                    80,
                    192,
                    128,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            let full = OwnedRegion(windows::Win32::Graphics::Gdi::CreateRectRgn(0, 0, 192, 128));
            full.apply(overlay.0).unwrap();
            let _ = UpdateWindow(base.0);
            let _ = UpdateWindow(overlay.0);
            // STATIC's built-in brush colors follow the Windows high-contrast
            // palette. Paint deterministic pixels after its initial WM_PAINT.
            for (hwnd, color) in [(base.0, 0x00ff_ffff), (overlay.0, 0)] {
                let dc = GetDC(Some(hwnd));
                let brush = CreateSolidBrush(COLORREF(color));
                assert_ne!(
                    FillRect(
                        dc,
                        &RECT {
                            left: 0,
                            top: 0,
                            right: 192,
                            bottom: 128
                        },
                        brush
                    ),
                    0
                );
                let _ = DeleteObject(brush.into());
                ReleaseDC(Some(hwnd), dc);
            }
            DwmFlush().unwrap();
            let rect = Rect {
                x: 30,
                y: 30,
                width: 100,
                height: 60,
            };
            let screen = Rect {
                x: 110,
                y: 110,
                ..rect
            };
            for engine in ["mss", "auto"] {
                let pixels = capture_through_hwnd(overlay.0, rect, || {
                    assert!(IsWindowVisible(overlay.0).as_bool());
                    let edge = capture(
                        Rect {
                            x: 85,
                            y: 85,
                            width: 4,
                            height: 4,
                        },
                        "mss",
                    )?;
                    assert!(
                        edge.pixels().all(|p| *p == image::Rgba([0, 0, 0, 255])),
                        "border pixels: {:?}",
                        edge.get_pixel(0, 0)
                    );
                    capture(screen, engine)
                })
                .unwrap();
                assert!(
                    pixels
                        .pixels()
                        .all(|p| *p == image::Rgba([255, 255, 255, 255])),
                    "{engine} must see the white desktop below the hole"
                );
            }
            let before = OwnedRegion::empty().unwrap();
            GetWindowRgn(overlay.0, before.0);
            let failure = capture_through_hwnd(overlay.0, rect, || {
                Err::<(), _>("fixture capture failed".into())
            });
            assert_eq!(failure, Err("fixture capture failed".into()));
            let after = OwnedRegion::empty().unwrap();
            GetWindowRgn(overlay.0, after.0);
            assert!(EqualRgn(before.0, after.0).as_bool());
            assert!(IsWindowVisible(overlay.0).as_bool());
            let hole = OwnedRegion(windows::Win32::Graphics::Gdi::CreateRectRgn(
                30, 30, 130, 90,
            ));
            let hollow = OwnedRegion::empty().unwrap();
            CombineRgn(Some(hollow.0), Some(before.0), Some(hole.0), RGN_DIFF);
            hollow.apply(overlay.0).unwrap();
            let original = OwnedRegion::empty().unwrap();
            GetWindowRgn(overlay.0, original.0);
            capture_through_hwnd(overlay.0, rect, || {
                let during = OwnedRegion::empty()?;
                GetWindowRgn(overlay.0, during.0);
                assert!(
                    EqualRgn(original.0, during.0).as_bool(),
                    "normal hollow sampling must not change the window shape"
                );
                Ok(())
            })
            .unwrap();
            // The user can switch/lock the desktop during sampling. Assert that
            // neither fixture took focus, rather than freezing the user's HWND.
            assert_ne!(GetForegroundWindow(), overlay.0);
            assert_ne!(GetForegroundWindow(), base.0);
            drop(overlay);
            drop(base);
        }
    }
    #[test]
    fn capture_scans_generated_qr_and_code128_without_ocr() {
        use rxing::{BarcodeFormat, MultiFormatWriter, Writer};
        for (format, text) in [
            (
                BarcodeFormat::QR_CODE,
                "https://example.org/screenpilot?test=1",
            ),
            (BarcodeFormat::CODE_128, "ScreenPilot-0123456789"),
        ] {
            let matrix = MultiFormatWriter.encode(text, &format, 420, 220).unwrap();
            let image = RgbaImage::from_fn(matrix.getWidth(), matrix.getHeight(), |x, y| {
                let value = if matrix.get(x, y) { 0 } else { 255 };
                image::Rgba([value, value, value, 255])
            });
            let results = scan(image);
            assert!(
                results.iter().any(|result| result["text"] == text),
                "{format:?}: {results:?}"
            );
        }
        assert!(scan(RgbaImage::from_pixel(
            100,
            100,
            image::Rgba([255, 255, 255, 255])
        ))
        .is_empty());
    }
    #[test]
    fn validates_regions_before_allocating() {
        assert!(Rect {
            width: u32::MAX,
            height: 1,
            ..Rect::default()
        }
        .validate()
        .is_err());
        assert!(Rect {
            x: -1920,
            y: -100,
            width: 100,
            height: 100
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn png_roundtrip_and_atomic_replacement() {
        let image = RgbaImage::from_pixel(13, 7, image::Rgba([15, 30, 80, 128]));
        assert_eq!(decode(&data_url(&image).unwrap()).unwrap(), image);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("截图.png");
        save(&image, &path, 90).unwrap();
        save(&image, &path, 90).unwrap();
        assert_eq!(image::open(path).unwrap().into_rgba8(), image);
    }
    #[test]
    fn capture_all_image_formats_accept_transparency() {
        let image = RgbaImage::from_pixel(13, 7, image::Rgba([15, 30, 80, 128]));
        let dir = tempfile::tempdir().unwrap();
        for extension in ["png", "jpg", "bmp", "webp", "pdf"] {
            let path = dir.path().join(format!("image.{extension}"));
            save(&image, &path, 90).unwrap();
            assert!(std::fs::metadata(&path).unwrap().len() > 20);
            if extension != "pdf" {
                let image = image::open(path).unwrap();
                assert_eq!((image.width(), image.height()), (13, 7));
            }
        }
    }

    // Read objects through the exported xref table, independently of the writer.
    fn pdf_objects(document: &[u8]) -> Vec<&[u8]> {
        assert!(document.starts_with(b"%PDF-1.7\n"));
        let marker = b"\nstartxref\n";
        let trailer = document
            .windows(marker.len())
            .rposition(|part| part == marker)
            .unwrap();
        let xref: usize = std::str::from_utf8(&document[trailer + marker.len()..])
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let mut lines = std::str::from_utf8(&document[xref..trailer])
            .unwrap()
            .lines();
        assert_eq!(lines.next(), Some("xref"));
        let header = lines.next().unwrap();
        let count: usize = header.strip_prefix("0 ").unwrap().parse().unwrap();
        assert_eq!(lines.next(), Some("0000000000 65535 f "));
        let mut offsets: Vec<usize> = lines
            .by_ref()
            .take(count - 1)
            .map(|line| {
                assert_eq!(&line[11..], "00000 n ");
                line[..10].parse().unwrap()
            })
            .collect();
        assert_eq!(offsets.len(), count - 1);
        assert!(lines
            .next()
            .unwrap()
            .contains(&format!("/Size {count} /Root 1 0 R")));
        offsets.push(xref);
        offsets
            .windows(2)
            .enumerate()
            .map(|(index, pair)| {
                let object = &document[pair[0]..pair[1]];
                assert!(object.starts_with(format!("{} 0 obj\n", index + 1).as_bytes()));
                assert!(object.ends_with(b"\nendobj\n"));
                object
            })
            .collect()
    }
    fn pdf_image(object: &[u8]) -> Vec<u8> {
        use std::io::Read;
        let marker = b"\nstream\n";
        let start = object
            .windows(marker.len())
            .position(|part| part == marker)
            .unwrap();
        let dictionary = std::str::from_utf8(&object[..start]).unwrap();
        assert!(dictionary.contains("/Filter /FlateDecode"));
        assert!(!dictionary.contains("/DCTDecode"));
        let length: usize = dictionary
            .split("/Length ")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let bytes = &object[start + marker.len()..][..length];
        assert_eq!(
            &object[start + marker.len() + length..],
            b"\nendstream\nendobj\n"
        );
        let mut decoded = Vec::new();
        flate2::read::ZlibDecoder::new(bytes)
            .read_to_end(&mut decoded)
            .unwrap();
        decoded
    }
    #[test]
    fn pdf_preserves_every_rgb_and_alpha_byte_and_valid_object_offsets() {
        let image = RgbaImage::from_fn(17, 11, |x, y| {
            image::Rgba([
                (x * 15) as u8,
                (y * 23) as u8,
                (x * 7 + y * 13) as u8,
                ((x * 17 + y * 19) % 256) as u8,
            ])
        });
        let document = pdf(&image).unwrap();
        let objects = pdf_objects(&document);
        assert_eq!(objects.len(), 6);
        assert!(std::str::from_utf8(objects[2])
            .unwrap()
            .contains("/MediaBox [0 0 17 11] /UserUnit 1"));
        let rgb: Vec<u8> = image
            .pixels()
            .flat_map(|pixel| pixel.0[..3].to_vec())
            .collect();
        let alpha: Vec<u8> = image.pixels().map(|pixel| pixel[3]).collect();
        assert_eq!(pdf_image(objects[3]), rgb);
        assert_eq!(pdf_image(objects[5]), alpha);
        assert!(objects[3].windows(12).any(|part| part == b"/SMask 6 0 R"));
    }
    #[test]
    fn opaque_and_long_pdf_keep_original_pixels_independent_of_jpeg_quality() {
        let image = RgbaImage::from_fn(3, 28_400, |x, y| {
            image::Rgba([(x * 80) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
        });
        let folder = tempfile::tempdir().unwrap();
        let low = folder.path().join("low.pdf");
        let high = folder.path().join("high.pdf");
        save(&image, &low, 0).unwrap();
        save(&image, &high, 100).unwrap();
        let document = std::fs::read(low).unwrap();
        assert_eq!(document, std::fs::read(high).unwrap());
        let objects = pdf_objects(&document);
        assert_eq!(objects.len(), 5);
        assert!(std::str::from_utf8(objects[2])
            .unwrap()
            .contains("/MediaBox [0 0 1.5 14200] /UserUnit 2"));
        assert_eq!(
            pdf_image(objects[3]),
            image
                .pixels()
                .flat_map(|pixel| pixel.0[..3].to_vec())
                .collect::<Vec<_>>()
        );
        assert!(!objects[3].windows(6).any(|part| part == b"/SMask"));
        assert!(pdf(&RgbaImage::new(0, 0)).is_err());
    }
    #[test]
    fn jpeg_quality_zero_and_one_hundred_are_valid_extremes() {
        let image = RgbaImage::from_fn(127, 79, |x, y| {
            image::Rgba([
                (x * 73 + y * 17) as u8,
                (x * 13 + y * 37) as u8,
                (x * 31 + y * 53) as u8,
                255,
            ])
        });
        let folder = tempfile::tempdir().unwrap();
        let low = folder.path().join("low.jpg");
        let high = folder.path().join("high.jpg");
        save(&image, &low, 0).unwrap();
        save(&image, &high, 100).unwrap();
        assert!(std::fs::metadata(&low).unwrap().len() < std::fs::metadata(&high).unwrap().len());
        assert_eq!(
            image::open(low).unwrap().to_rgb8().dimensions(),
            image.dimensions()
        );
        assert_eq!(
            image::open(high).unwrap().to_rgb8().dimensions(),
            image.dimensions()
        );
    }
}
