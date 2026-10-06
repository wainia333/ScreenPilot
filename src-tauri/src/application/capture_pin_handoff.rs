//! The selection's native pixel surface survives the entire pin lifetime.
//! WebView2 supplies controls/input; its fractional-DPI raster never replaces it.
use super::capture_native::Rect;
use image::RgbaImage;
use std::sync::{
    atomic::{AtomicIsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow};
use windows::Win32::Foundation::HWND;

pub struct SelectionCover {
    app: AppHandle,
    hwnd: Arc<AtomicIsize>,
    pub rect: Rect,
    #[cfg(any(test, debug_assertions))]
    pub image: Arc<RgbaImage>,
    pub frame: Option<super::capture_pins::SelectionFrame>,
    placement: Arc<Mutex<Option<Rect>>>,
    packet_hash: Mutex<Option<[u8; 32]>>,
    source: Mutex<Option<Arc<RgbaImage>>>,
}
impl SelectionCover {
    pub fn retain_source(
        app: &AppHandle,
        window: &WebviewWindow,
        selection: Rect,
        mask: RgbaImage,
        frame: Option<super::capture_pins::SelectionFrame>,
    ) -> Result<Arc<Self>, String> {
        if let Some(frame) = &frame {
            frame.validate()?;
        }
        let area = Self::expand(selection, frame.as_ref().map_or(0, |f| f.padding()))?;
        if mask.dimensions() != (area.width, area.height) {
            return Err("钉图留屏尺寸与选区不一致".into());
        }
        super::capture_native::with_readable_pin_source(window, || {
            let mut pixels = super::capture_native::capture(area, "mss")?;
            // Keep the actual displayed raster, including fractional-DPI edge
            // colors. The exported canvas only specifies its transparent shape.
            clean_selection_controls(
                &mut pixels,
                &mask,
                frame.as_ref().map_or(0, |f| f.padding()),
            );
            Self::show_frame(app, selection, pixels, frame)
        })
    }
    pub fn show(app: &AppHandle, rect: Rect, image: RgbaImage) -> Result<Arc<Self>, String> {
        Self::show_frame(app, rect, image, None)
    }
    pub fn show_with_visibility(
        app: &AppHandle,
        rect: Rect,
        image: RgbaImage,
        visible: bool,
    ) -> Result<Arc<Self>, String> {
        Self::create_frame(app, rect, image, None, visible)
    }
    pub fn show_frame(
        app: &AppHandle,
        selection: Rect,
        image: RgbaImage,
        frame: Option<super::capture_pins::SelectionFrame>,
    ) -> Result<Arc<Self>, String> {
        Self::create_frame(app, selection, image, frame, true)
    }
    fn create_frame(
        app: &AppHandle,
        selection: Rect,
        image: RgbaImage,
        frame: Option<super::capture_pins::SelectionFrame>,
        visible: bool,
    ) -> Result<Arc<Self>, String> {
        let padding = if let Some(frame) = &frame {
            frame.validate()?;
            frame.padding()
        } else {
            0
        };
        let rect = Self::expand(selection, padding)?;
        rect.validate()?;
        if (rect.width, rect.height) != image.dimensions() {
            return Err("钉图留屏尺寸与选区不一致".into());
        }
        let image = Arc::new(image);
        let pixels = image.clone();
        let (sender, receiver) = mpsc::channel();
        app.run_on_main_thread(move || {
            let result = show_bitmap(rect, &pixels, visible);
            if let Err(mpsc::SendError(Ok(hwnd))) = sender.send(result) {
                destroy_bitmap(hwnd);
            }
        })
        .map_err(|e| e.to_string())?;
        let hwnd = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图留屏准备超时".to_string())??;
        Ok(Arc::new(Self {
            app: app.clone(),
            hwnd: Arc::new(AtomicIsize::new(hwnd)),
            rect,
            #[cfg(any(test, debug_assertions))]
            image,
            frame,
            placement: Arc::new(Mutex::new(None)),
            packet_hash: Mutex::new(None),
            source: Mutex::new(None),
        }))
    }
    pub fn matches_packet(&self, png: &str) -> Result<bool, String> {
        use sha2::{Digest, Sha256};
        let hash: [u8; 32] = Sha256::digest(png.as_bytes()).into();
        Ok(*self.packet_hash.lock().map_err(|e| e.to_string())? == Some(hash))
    }
    pub fn remember_packet(&self, png: &str) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        *self.packet_hash.lock().map_err(|e| e.to_string())? =
            Some(Sha256::digest(png.as_bytes()).into());
        Ok(())
    }
    fn expand(area: Rect, padding: u32) -> Result<Rect, String> {
        Rect {
            x: area
                .x
                .checked_sub(padding as i32)
                .ok_or("钉图边框坐标无效")?,
            y: area
                .y
                .checked_sub(padding as i32)
                .ok_or("钉图边框坐标无效")?,
            width: area
                .width
                .checked_add(padding * 2)
                .ok_or("钉图边框尺寸无效")?,
            height: area
                .height
                .checked_add(padding * 2)
                .ok_or("钉图边框尺寸无效")?,
        }
        .validate()
    }
    pub fn hwnd(&self) -> Result<HWND, String> {
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd == 0 {
            return Err("钉图交接已取消".into());
        }
        Ok(HWND(hwnd as *mut _))
    }
    pub fn close(&self) {
        let hwnd = self.hwnd.swap(0, Ordering::AcqRel);
        if hwnd != 0 {
            let _ = self.app.run_on_main_thread(move || destroy_bitmap(hwnd));
        }
    }
    /// Bind client geometry without replacing the retained selection pixels.
    pub fn bind(self: &Arc<Self>, window: &WebviewWindow, area: Rect) -> Result<(), String> {
        let target = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let surface = self.clone();
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let hwnd = HWND(target as *mut _);
                let result = (|| {
                    attach_follow(hwnd, &surface)?;
                    *surface.placement.lock().map_err(|e| e.to_string())? = Some(area);
                    surface.follow(hwnd)
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图绑定超时".to_string())?
    }
    /// Cache document pixels; zoom/opacity/focus packets carry only metadata.
    pub fn render_view(
        &self,
        source: Option<RgbaImage>,
        visual: &super::capture_pin_render::Visual,
    ) -> Result<RgbaImage, String> {
        let source = {
            let mut cache = self.source.lock().map_err(|e| e.to_string())?;
            if let Some(source) = source {
                *cache = Some(Arc::new(source));
            }
            cache.clone().ok_or("缺少钉图原始画面")?
        };
        super::capture_pin_render::render(&source, visual)
    }
    /// Host geometry, hit regions and pixels commit in one UI-thread operation.
    /// No compositor wait between resizing the input host and updating its image.
    pub fn commit_view(
        self: &Arc<Self>,
        window: &WebviewWindow,
        bounds: Rect,
        area: Rect,
        regions: Vec<Rect>,
        image: RgbaImage,
    ) -> Result<(), String> {
        if image.dimensions() != (area.width, area.height) {
            return Err("钉图像素尺寸不一致".into());
        }
        let target = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let surface = self.clone();
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let result = (|| {
                    use windows::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
                    let hwnd = HWND(target as *mut _);
                    attach_follow(hwnd, &surface)?;
                    let mut origin = RECT::default();
                    unsafe {
                        GetWindowRect(hwnd, &mut origin).map_err(|e| e.to_string())?;
                    }
                    let bounds = Rect {
                        x: origin.left.saturating_add(bounds.x),
                        y: origin.top.saturating_add(bounds.y),
                        ..bounds
                    };
                    // Keep the old image fixed until the new bitmap is ready.
                    *surface.placement.lock().map_err(|e| e.to_string())? = None;
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            None,
                            bounds.x,
                            bounds.y,
                            bounds.width as i32,
                            bounds.height as i32,
                            SWP_NOACTIVATE | SWP_NOZORDER,
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    super::capture_native::set_hwnd_hit_regions(hwnd, &regions)?;
                    // UpdateLayeredWindow changes the bitmap, position and size
                    // together. Never move the old bitmap to the new inset first.
                    paint_bitmap(
                        surface.hwnd()?,
                        Rect {
                            x: bounds.x + area.x,
                            y: bounds.y + area.y,
                            ..area
                        },
                        &image,
                    )?;
                    *surface.placement.lock().map_err(|e| e.to_string())? = Some(area);
                    surface.follow(hwnd)
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图画面更新超时".to_string())?
    }
    pub fn resize_host(
        self: &Arc<Self>,
        window: &WebviewWindow,
        bounds: Rect,
        area: Rect,
    ) -> Result<(), String> {
        let target = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let surface = self.clone();
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let result = (|| {
                    use windows::Win32::{Graphics::Dwm::DwmFlush, UI::WindowsAndMessaging::*};
                    let hwnd = HWND(target as *mut _);
                    // Commit the new input inset and host position together, so a
                    // toolbar expansion cannot briefly move the retained picture.
                    *surface.placement.lock().map_err(|e| e.to_string())? = Some(area);
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            None,
                            bounds.x,
                            bounds.y,
                            bounds.width as i32,
                            bounds.height as i32,
                            SWP_NOACTIVATE | SWP_NOZORDER,
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    surface.follow(hwnd)?;
                    unsafe {
                        DwmFlush().map_err(|e| e.to_string())?;
                    }
                    Ok(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图布局更新超时".to_string())?
    }
    /// Called synchronously by the pin's native move/focus event on the UI thread.
    pub fn follow(&self, window: HWND) -> Result<(), String> {
        PinFollower {
            hwnd: self.hwnd.clone(),
            placement: self.placement.clone(),
        }
        .follow(window)
    }
    pub fn update(
        self: &Arc<Self>,
        window: &WebviewWindow,
        area: Rect,
        image: RgbaImage,
    ) -> Result<(), String> {
        area.validate()?;
        if image.dimensions() != (area.width, area.height) {
            return Err("钉图像素尺寸不一致".into());
        }
        let surface = self.clone();
        let target = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let result = (|| {
                    use windows::Win32::{
                        Foundation::RECT, UI::WindowsAndMessaging::GetWindowRect,
                    };
                    let target = HWND(target as *mut _);
                    let mut origin = RECT::default();
                    unsafe {
                        GetWindowRect(target, &mut origin).map_err(|e| e.to_string())?;
                    }
                    paint_bitmap(
                        surface.hwnd()?,
                        Rect {
                            x: origin.left + area.x,
                            y: origin.top + area.y,
                            ..area
                        },
                        &image,
                    )?;
                    *surface.placement.lock().map_err(|e| e.to_string())? = Some(area);
                    surface.follow(target)
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图绘制超时".to_string())?
    }
    pub fn hide(&self) {
        if let Ok(hwnd) = self.hwnd() {
            let raw = hwnd.0 as isize;
            let _ = self.app.run_on_main_thread(move || unsafe {
                use windows::Win32::UI::WindowsAndMessaging::*;
                let _ = SetWindowPos(
                    HWND(raw as *mut _),
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_HIDEWINDOW,
                );
            });
        }
    }
    /// Change both the input host and the retained pixels in the same UI turn.
    /// Hidden pins keep their bitmap, geometry and durable record intact.
    pub fn set_visibility(
        self: &Arc<Self>,
        window: &WebviewWindow,
        visible: bool,
    ) -> Result<(), String> {
        let surface = self.clone();
        let window = window.clone();
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let result = (|| {
                    use tauri::Manager;
                    use windows::Win32::UI::WindowsAndMessaging::*;
                    if window
                        .app_handle()
                        .state::<super::state::AppState>()
                        .current()?
                        .capture
                        .pins_visible
                        != visible
                    {
                        return Ok(());
                    }
                    super::lifecycle::disable_capture_window_transitions(
                        window.hwnd().map_err(|e| e.to_string())?,
                    )?;
                    if visible {
                        window.show()
                    } else {
                        window.hide()
                    }
                    .map_err(|e| e.to_string())?;
                    let hwnd = surface.hwnd()?;
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
                                | SWP_NOACTIVATE
                                | SWP_NOZORDER
                                | if visible {
                                    SWP_SHOWWINDOW
                                } else {
                                    SWP_HIDEWINDOW
                                },
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    if visible {
                        surface.follow(window.hwnd().map_err(|e| e.to_string())?)?;
                    }
                    Ok(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图显示状态更新超时".to_string())?
    }
    pub fn resume(&self) -> Result<(), String> {
        let raw = self.hwnd()?.0 as isize;
        let (sender, receiver) = mpsc::channel();
        self.app
            .run_on_main_thread(move || unsafe {
                use windows::Win32::UI::WindowsAndMessaging::*;
                let _ = sender.send(
                    SetWindowPos(
                        HWND(raw as *mut _),
                        None,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
                    )
                    .map_err(|e| e.to_string()),
                );
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "钉图显示超时".to_string())?
    }
}

// Preserve the selected desktop raster away from the perimeter. Rebuild the
// perimeter from the clean export so a captured resize handle cannot survive.
fn clean_selection_controls(pixels: &mut RgbaImage, mask: &RgbaImage, padding: u32) {
    let (width, height) = pixels.dimensions();
    let collar = padding + 16;
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        let shape = mask.get_pixel(x, y);
        if x < collar || y < collar || x + collar >= width || y + collar >= height {
            *pixel = *shape;
        } else {
            pixel[3] = if shape[3] == 0 { 0 } else { 255 };
        }
    }
}
const FOLLOW_SUBCLASS: usize = 0x5350_464c;
fn attach_follow(hwnd: HWND, surface: &Arc<SelectionCover>) -> Result<(), String> {
    attach_follower(
        hwnd,
        PinFollower {
            hwnd: surface.hwnd.clone(),
            placement: surface.placement.clone(),
        },
    )
}
struct PinFollower {
    hwnd: Arc<AtomicIsize>,
    placement: Arc<Mutex<Option<Rect>>>,
}
impl PinFollower {
    fn follow(&self, window: HWND) -> Result<(), String> {
        use windows::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
        let raw = self.hwnd.load(Ordering::Acquire);
        if raw == 0 {
            return Ok(());
        }
        // Win32 can re-enter a window procedure while changing z-order.
        // Release the placement lock before calling any window API.
        let area = *self.placement.lock().map_err(|e| e.to_string())?;
        if let Some(area) = area {
            unsafe {
                let mut origin = RECT::default();
                GetWindowRect(window, &mut origin).map_err(|e| e.to_string())?;
                SetWindowPos(
                    HWND(raw as *mut _),
                    Some(window),
                    origin.left + area.x,
                    origin.top + area.y,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOSIZE,
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
fn attach_follower(hwnd: HWND, follower: PinFollower) -> Result<(), String> {
    use windows::Win32::UI::Shell::{GetWindowSubclass, SetWindowSubclass};
    unsafe {
        let mut existing = 0;
        if GetWindowSubclass(
            hwnd,
            Some(follow_proc),
            FOLLOW_SUBCLASS,
            Some(&mut existing),
        )
        .as_bool()
        {
            return Ok(());
        }
        let data = Box::into_raw(Box::new(follower));
        if !SetWindowSubclass(hwnd, Some(follow_proc), FOLLOW_SUBCLASS, data as usize).as_bool() {
            drop(Box::from_raw(data));
            return Err("钉图拖动初始化失败".into());
        }
    }
    Ok(())
}
unsafe extern "system" fn follow_proc(
    hwnd: HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    id: usize,
    data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{
        UI::Shell::{DefSubclassProc, RemoveWindowSubclass},
        UI::WindowsAndMessaging::*,
    };
    if message == WM_WINDOWPOSCHANGED || message == WM_ACTIVATE {
        let follower = &*(data as *const PinFollower);
        let _ = follower.follow(hwnd);
    }
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(follow_proc), id);
        drop(Box::from_raw(data as *mut PinFollower));
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}
impl Drop for SelectionCover {
    fn drop(&mut self) {
        self.close();
    }
}

fn destroy_bitmap(hwnd: isize) {
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(HWND(hwnd as *mut _));
    }
}

fn paint_bitmap(hwnd: HWND, rect: Rect, image: &RgbaImage) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{COLORREF, POINT, SIZE},
        Graphics::{
            Dwm::DwmFlush,
            Gdi::{
                CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
                AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION,
                DIB_RGB_COLORS,
            },
        },
        UI::WindowsAndMessaging::{UpdateLayeredWindow, ULW_ALPHA},
    };
    unsafe {
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err("无法创建钉图留屏画布".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: rect.width as i32,
                biHeight: -(rect.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(e) => {
                let _ = DeleteDC(dc);
                return Err(e.to_string());
            }
        };
        let old = SelectObject(dc, bitmap.into());
        let buffer = std::slice::from_raw_parts_mut(bits.cast::<u8>(), image.as_raw().len());
        for (target, pixel) in buffer.chunks_exact_mut(4).zip(image.pixels()) {
            let a = u16::from(pixel[3]);
            target.copy_from_slice(&[
                ((u16::from(pixel[2]) * a + 127) / 255) as u8,
                ((u16::from(pixel[1]) * a + 127) / 255) as u8,
                ((u16::from(pixel[0]) * a + 127) / 255) as u8,
                pixel[3],
            ]);
        }
        let result = (|| {
            UpdateLayeredWindow(
                hwnd,
                None,
                Some(&POINT {
                    x: rect.x,
                    y: rect.y,
                }),
                Some(&SIZE {
                    cx: rect.width as i32,
                    cy: rect.height as i32,
                }),
                Some(dc),
                Some(&POINT::default()),
                COLORREF(0),
                Some(&BLENDFUNCTION {
                    BlendOp: AC_SRC_OVER as u8,
                    BlendFlags: 0,
                    SourceConstantAlpha: 255,
                    AlphaFormat: AC_SRC_ALPHA as u8,
                }),
                ULW_ALPHA,
            )
            .map_err(|e| e.to_string())?;
            DwmFlush().map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = SelectObject(dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        result
    }
}

fn show_bitmap(rect: Rect, image: &RgbaImage, visible: bool) -> Result<isize, String> {
    use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
    unsafe {
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            w!("STATIC"),
            w!("ScreenPilot pin pixels"),
            WS_POPUP,
            rect.x,
            rect.y,
            rect.width as i32,
            rect.height as i32,
            None,
            None,
            None,
            None,
        )
        .map_err(|e| e.to_string())?;
        let result = (|| {
            super::lifecycle::disable_capture_window_transitions(hwnd)?;
            paint_bitmap(hwnd, rect, image)?;
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOACTIVATE
                    | if visible {
                        SWP_SHOWWINDOW
                    } else {
                        SWP_HIDEWINDOW
                    },
            )
            .map_err(|e| e.to_string())?;
            windows::Win32::Graphics::Dwm::DwmFlush().map_err(|e| e.to_string())?;
            Ok(hwnd.0 as isize)
        })();
        if result.is_err() {
            destroy_bitmap(hwnd.0 as isize);
        }
        result
    }
}

/// CapturePreview completes only after WebView2 has produced a raster. Run this
/// off the UI thread; the COM callback reads its stream on the UI thread.
#[cfg(any(test, debug_assertions))]
pub fn preview(window: &WebviewWindow) -> Result<RgbaImage, String> {
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::{
        System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET},
        UI::Shell::SHCreateMemStream,
    };
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let failure = sender.clone();
            let result = (|| unsafe {
                let stream =
                    SHCreateMemStream(None).ok_or_else(|| "无法读取钉图画面".to_string())?;
                let output = stream.clone();
                let complete = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                    let result = (|| {
                        status.map_err(|e| e.to_string())?;
                        let mut stat = STATSTG::default();
                        output
                            .Stat(&mut stat, STATFLAG_NONAME)
                            .map_err(|e| e.to_string())?;
                        let size =
                            u32::try_from(stat.cbSize).map_err(|_| "钉图画面过大".to_string())?;
                        if size > 128_000_000 {
                            return Err("钉图画面过大".into());
                        }
                        let mut bytes = vec![0; size as usize];
                        let mut read = 0;
                        output
                            .Seek(0, STREAM_SEEK_SET, None)
                            .map_err(|e| e.to_string())?;
                        output
                            .Read(bytes.as_mut_ptr().cast(), size, Some(&mut read))
                            .ok()
                            .map_err(|e| e.to_string())?;
                        if read != size {
                            return Err("钉图画面读取不完整".into());
                        }
                        Ok(bytes)
                    })();
                    let _ = sender.send(result);
                    Ok(())
                }));
                webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|e| e.to_string())?
                    .CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &complete,
                    )
                    .map_err(|e| e.to_string())
            })();
            if let Err(error) = result {
                let _ = failure.send(Err(error));
            }
        })
        .map_err(|e| e.to_string())?;
    let bytes = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "钉图画面验证超时".to_string())??;
    image::load_from_memory(&bytes)
        .map(|image| image.into_rgba8())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
fn pixels_match(
    frame: &RgbaImage,
    window_size: (u32, u32),
    area: Rect,
    expected: &RgbaImage,
    opacity: f64,
) -> bool {
    pixels_match_interior(frame, window_size, area, expected, opacity, 0)
}

#[cfg(any(test, debug_assertions))]
fn pixels_match_interior(
    frame: &RgbaImage,
    window_size: (u32, u32),
    area: Rect,
    expected: &RgbaImage,
    opacity: f64,
    padding: u32,
) -> bool {
    if expected.width() == 0
        || expected.height() == 0
        || window_size.0 == 0
        || window_size.1 == 0
        || area.x < 0
        || area.y < 0
        || area.width == 0
        || area.height == 0
        || expected.width() <= padding * 2
        || expected.height() <= padding * 2
        || area.width <= padding * 2
        || area.height <= padding * 2
    {
        return false;
    }
    let mut matched = 0;
    // Keep the original content grid when an outline is added around it.
    // Sampling the padded dimensions shifts points onto high-contrast image
    // seams, where Chromium's fractional-DPI raster filtering is visible.
    let area = Rect {
        x: area.x + padding as i32,
        y: area.y + padding as i32,
        width: area.width - padding * 2,
        height: area.height - padding * 2,
    };
    // Chromium rounds the CSS viewport up at fractional DPI. An extra edge
    // pixel in its PNG is padding, not a rescaling of the selected canvas.
    let raster_width = if frame.width().abs_diff(window_size.0) <= 2 {
        window_size.0
    } else {
        frame.width()
    };
    let raster_height = if frame.height().abs_diff(window_size.1) <= 2 {
        window_size.1
    } else {
        frame.height()
    };
    for row in 1..=9 {
        for col in 1..=9 {
            let content_width = expected.width() - padding * 2;
            let content_height = expected.height() - padding * 2;
            let mut point = (
                content_width * col as u32 / 10,
                content_height * row as u32 / 10,
            );
            // CapturePreview can filter a subpixel edge even when the canvas
            // is 1:1. Choose a nearby stable pixel instead of a tile boundary;
            // the coordinates used to compare both rasters remain identical.
            let gradient = |x: u32, y: u32| {
                let p = expected.get_pixel(padding + x, padding + y);
                [
                    (x.saturating_sub(1), y),
                    ((x + 1).min(content_width - 1), y),
                    (x, y.saturating_sub(1)),
                    (x, (y + 1).min(content_height - 1)),
                ]
                .iter()
                .flat_map(|&(nx, ny)| {
                    let q = expected.get_pixel(padding + nx, padding + ny);
                    (0..4).map(move |c| p[c].abs_diff(q[c]))
                })
                .max()
                .unwrap_or(0)
            };
            let mut best = gradient(point.0, point.1);
            let origin = point;
            for dy in -2_i32..=2 {
                for dx in -2_i32..=2 {
                    let x = (origin.0 as i32 + dx).clamp(0, content_width as i32 - 1) as u32;
                    let y = (origin.1 as i32 + dy).clamp(0, content_height as i32 - 1) as u32;
                    let score = gradient(x, y);
                    if score < best {
                        best = score;
                        point = (x, y);
                    }
                }
            }
            let x = (u64::from(area.x as u32) * u64::from(content_width)
                + u64::from(area.width) * u64::from(point.0))
                * u64::from(raster_width)
                / (u64::from(content_width) * u64::from(window_size.0));
            let y = (u64::from(area.y as u32) * u64::from(content_height)
                + u64::from(area.height) * u64::from(point.1))
                * u64::from(raster_height)
                / (u64::from(content_height) * u64::from(window_size.1));
            if x >= u64::from(frame.width()) || y >= u64::from(frame.height()) {
                return false;
            }
            let actual = frame.get_pixel(x as u32, y as u32);
            let wanted = expected.get_pixel(padding + point.0, padding + point.1);
            let alpha = (f64::from(wanted[3]) * opacity).round() as u8;
            if actual[3].abs_diff(alpha) <= 3 && (0..3).all(|c| actual[c].abs_diff(wanted[c]) <= 8)
            {
                matched += 1;
            }
        }
    }
    matched >= 77
}

#[cfg(any(test, debug_assertions))]
pub fn wait_painted(
    window: &WebviewWindow,
    area: Rect,
    expected: &RgbaImage,
    opacity: f64,
    check: impl FnMut() -> Result<(), String>,
) -> Result<u32, String> {
    wait_painted_with_frame(window, area, expected, opacity, 0, check)
}

#[cfg(any(test, debug_assertions))]
fn frame_edges_match(
    frame: &RgbaImage,
    size: (u32, u32),
    area: Rect,
    expected: &RgbaImage,
    opacity: f64,
    padding: u32,
) -> bool {
    if padding == 0 {
        return true;
    }
    if area.x < 0
        || area.y < 0
        || expected.width() <= padding * 2
        || expected.height() <= padding * 2
    {
        return false;
    }
    let rw = if frame.width().abs_diff(size.0) <= 2 {
        size.0
    } else {
        frame.width()
    };
    let rh = if frame.height().abs_diff(size.1) <= 2 {
        size.1
    } else {
        frame.height()
    };
    let pixel_matches = |x: u32, y: u32| {
        let wanted = expected.get_pixel(x, y);
        let fx = (u64::from(area.x as u32 + x) * u64::from(rw) / u64::from(size.0)) as u32;
        let fy = (u64::from(area.y as u32 + y) * u64::from(rh) / u64::from(size.1)) as u32;
        if fx >= frame.width() || fy >= frame.height() {
            return false;
        }
        let actual = frame.get_pixel(fx, fy);
        let alpha = (f64::from(wanted[3]) * opacity).round() as u8;
        actual[3].abs_diff(alpha) <= 3
            && (alpha == 0 || (0..3).all(|c| actual[c].abs_diff(wanted[c]) <= 8))
    };
    // The interior grid alone misses the entire selection border. Check both
    // sides of its centered stroke, away from corners and resize handles.
    for step in 1..8 {
        let x = padding + (expected.width() - padding * 2) * step / 8;
        let y = padding + (expected.height() - padding * 2) * step / 8;
        for edge_x in [
            padding - 1,
            padding,
            expected.width() - padding - 1,
            expected.width() - padding,
        ] {
            if !pixel_matches(edge_x, y) {
                return false;
            }
        }
        for edge_y in [
            padding - 1,
            padding,
            expected.height() - padding - 1,
            expected.height() - padding,
        ] {
            if !pixel_matches(x, edge_y) {
                return false;
            }
        }
    }
    true
}

#[cfg(any(test, debug_assertions))]
pub fn wait_painted_with_frame(
    window: &WebviewWindow,
    area: Rect,
    expected: &RgbaImage,
    opacity: f64,
    padding: u32,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<u32, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut attempts = 0;
    loop {
        check()?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let frame = preview(window)?;
        attempts += 1;
        if pixels_match_interior(
            &frame,
            (size.width, size.height),
            area,
            expected,
            opacity,
            padding,
        ) && frame_edges_match(
            &frame,
            (size.width, size.height),
            area,
            expected,
            opacity,
            padding,
        ) {
            return Ok(attempts);
        }
        if std::time::Instant::now() >= deadline {
            return Err("钉图画面尚未绘制完成，请重试".into());
        }
        std::thread::sleep(Duration::from_millis(16));
    }
}

#[cfg(debug_assertions)]
pub fn check_native_pin_follower() {
    use windows::{
        core::w,
        Win32::{Foundation::RECT, UI::WindowsAndMessaging::*},
    };
    struct HiddenWindow(HWND);
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    unsafe {
        // Hidden same-thread windows test actual Win32 message ordering,
        // without taking focus, painting the desktop or touching user pins.
        let create = || {
            HiddenWindow(
                CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    w!("STATIC"),
                    w!("Pin follow test"),
                    WS_POPUP,
                    30,
                    40,
                    100,
                    80,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            )
        };
        let host = create();
        let bitmap = create();
        let placement = Arc::new(Mutex::new(Some(Rect {
            x: 12,
            y: 12,
            width: 60,
            height: 40,
        })));
        let pixel_hwnd = Arc::new(AtomicIsize::new(bitmap.0 .0 as isize));
        attach_follower(
            host.0,
            PinFollower {
                hwnd: pixel_hwnd,
                placement: placement.clone(),
            },
        )
        .unwrap();
        for step in 1..=100 {
            SetWindowPos(
                host.0,
                None,
                30 + step * 2,
                40 - step,
                100,
                80,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .unwrap();
            let mut source = RECT::default();
            let mut target = RECT::default();
            GetWindowRect(host.0, &mut source).unwrap();
            GetWindowRect(bitmap.0, &mut target).unwrap();
            assert_eq!(
                (target.left, target.top),
                (source.left + 12, source.top + 12)
            );
        }
        assert_eq!(Arc::strong_count(&placement), 2);
        drop(host);
        assert_eq!(Arc::strong_count(&placement), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_pin_bitmap_never_flashes_during_creation_or_repaint() {
        use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
        let rect = Rect {
            x: 40,
            y: 40,
            width: 20,
            height: 20,
        };
        let image = RgbaImage::from_pixel(20, 20, image::Rgba([51, 136, 255, 255]));
        let raw = show_bitmap(rect, &image, false).unwrap();
        let hwnd = HWND(raw as *mut _);
        unsafe {
            assert!(!IsWindowVisible(hwnd).as_bool());
        }
        paint_bitmap(hwnd, rect, &image).unwrap();
        unsafe {
            assert!(!IsWindowVisible(hwnd).as_bool());
        }
        destroy_bitmap(raw);
    }
    #[test]
    fn retained_selection_removes_all_eight_handle_rasters_without_replacing_the_middle() {
        let mask = RgbaImage::from_pixel(206, 126, image::Rgba([20, 40, 80, 255]));
        let mut captured = RgbaImage::from_pixel(206, 126, image::Rgba([21, 41, 81, 255]));
        for (x, y) in [
            (3_u32, 3_u32),
            (103, 3),
            (203, 3),
            (203, 63),
            (203, 123),
            (103, 123),
            (3, 123),
            (3, 63),
        ] {
            for px in x.saturating_sub(12_u32)..(x + 12).min(206) {
                for py in y.saturating_sub(12_u32)..(y + 12).min(126) {
                    captured.put_pixel(px, py, image::Rgba([255, 255, 255, 255]));
                }
            }
        }
        clean_selection_controls(&mut captured, &mask, 3);
        for (x, y) in [
            (3, 3),
            (103, 3),
            (203, 3),
            (203, 63),
            (203, 123),
            (103, 123),
            (3, 123),
            (3, 63),
        ] {
            assert_eq!(captured.get_pixel(x, y), mask.get_pixel(x, y));
        }
        assert_eq!(*captured.get_pixel(103, 63), image::Rgba([21, 41, 81, 255]));
    }
    #[test]
    fn padded_content_accepts_filtered_image_seams_but_rejects_a_missing_picture() {
        let image = RgbaImage::from_fn(120, 80, |_, y| {
            image::Rgba([37, if y < 40 { 240 } else { 4 }, 201, 255])
        });
        let mut expected = RgbaImage::new(126, 86);
        image::imageops::replace(&mut expected, &image, 3, 3);
        let filtered = image::imageops::blur(&expected, 0.4);
        let mut raster = RgbaImage::new(150, 110);
        image::imageops::replace(&mut raster, &filtered, 9, 9);
        let area = Rect {
            x: 9,
            y: 9,
            width: 126,
            height: 86,
        };
        assert!(pixels_match_interior(
            &raster,
            (150, 110),
            area,
            &expected,
            1.0,
            3
        ));
        assert!(!pixels_match_interior(
            &RgbaImage::new(150, 110),
            (150, 110),
            area,
            &expected,
            1.0,
            3
        ));
        assert!(!pixels_match_interior(
            &raster,
            (150, 110),
            Rect { x: 60, ..area },
            &expected,
            1.0,
            3
        ));
    }
    #[test]
    fn selection_paint_requires_the_border_even_when_all_interior_samples_match() {
        let area = Rect {
            x: 12,
            y: 12,
            width: 126,
            height: 86,
        };
        let mut expected = RgbaImage::new(126, 86);
        for y in 1..85 {
            for x in 1..125 {
                expected.put_pixel(
                    x,
                    y,
                    image::Rgba(if !(5..121).contains(&x) || !(5..81).contains(&y) {
                        [51, 136, 255, 255]
                    } else {
                        [37, 129, 201, 255]
                    }),
                );
            }
        }
        let mut complete = RgbaImage::new(150, 110);
        image::imageops::replace(&mut complete, &expected, 12, 12);
        assert!(frame_edges_match(
            &complete,
            (150, 110),
            area,
            &expected,
            1.0,
            3
        ));
        let mut missing_border = complete.clone();
        for y in 1..85 {
            for x in 1..125 {
                if !(5..121).contains(&x) || !(5..81).contains(&y) {
                    missing_border.put_pixel(x + 12, y + 12, image::Rgba([0, 0, 0, 0]));
                }
            }
        }
        assert!(pixels_match(
            &missing_border,
            (150, 110),
            area,
            &expected,
            1.0
        ));
        assert!(!frame_edges_match(
            &missing_border,
            (150, 110),
            area,
            &expected,
            1.0,
            3
        ));
        assert_eq!(
            SelectionCover::expand(
                Rect {
                    x: 0,
                    y: 0,
                    width: 120,
                    height: 80
                },
                3
            )
            .unwrap()
            .x,
            -3
        );
    }
    #[test]
    fn paint_check_rejects_empty_black_and_shifted_frames_and_checks_opacity() {
        let image = RgbaImage::from_pixel(120, 80, image::Rgba([37, 129, 201, 255]));
        let area = Rect {
            x: 12,
            y: 12,
            width: 120,
            height: 80,
        };
        let mut frame = RgbaImage::new(144, 104);
        assert!(!pixels_match(&frame, (144, 104), area, &image, 1.0));
        image::imageops::replace(&mut frame, &image, 12, 12);
        assert!(pixels_match(&frame, (144, 104), area, &image, 1.0));
        assert!(!pixels_match(
            &frame,
            (144, 104),
            Rect { x: 60, ..area },
            &image,
            1.0
        ));
        assert!(!pixels_match(&frame, (144, 104), area, &image, 0.5));
        for pixel in frame.pixels_mut().filter(|p| p[3] > 0) {
            pixel[3] = 128;
        }
        assert!(pixels_match(&frame, (144, 104), area, &image, 0.5));
        assert!(!pixels_match(
            &RgbaImage::from_pixel(144, 104, image::Rgba([0, 0, 0, 255])),
            (144, 104),
            area,
            &image,
            1.0
        ));
    }
    #[test]
    fn native_bitmap_keeps_exact_selected_pixels_when_both_webview_surfaces_are_absent() {
        let _desktop = super::super::capture_native::DESKTOP_CAPTURE_TEST_LOCK
            .lock()
            .unwrap();
        use windows::Win32::{
            Graphics::Dwm::DwmFlush,
            UI::{
                HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
                WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsWindowVisible},
            },
        };
        unsafe {
            let old_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let foreground = GetForegroundWindow();
            let rect = Rect {
                x: 80,
                y: 80,
                width: 96,
                height: 64,
            };
            let image = RgbaImage::from_fn(96, 64, |x, y| {
                image::Rgba([x as u8, (y * 3) as u8, 201, 255])
            });
            let raw = show_bitmap(rect, &image, true).unwrap();
            let hwnd = HWND(raw as *mut _);
            assert!(IsWindowVisible(hwnd).as_bool());
            let mut bounds = windows::Win32::Foundation::RECT::default();
            GetWindowRect(hwnd, &mut bounds).unwrap();
            assert_eq!(
                (bounds.left, bounds.top, bounds.right, bounds.bottom),
                (80, 80, 176, 144)
            );
            for _ in 0..8 {
                DwmFlush().unwrap();
                assert_eq!(
                    super::super::capture_native::capture(rect, "mss").unwrap(),
                    image
                );
                assert_ne!(GetForegroundWindow(), hwnd);
                std::thread::sleep(Duration::from_millis(16));
            }
            destroy_bitmap(raw);
            assert_ne!(foreground, hwnd);
            SetThreadDpiAwarenessContext(old_dpi);
        }
    }
}
