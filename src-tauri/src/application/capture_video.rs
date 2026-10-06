//! GIF uses the upstream Rust encoder. MP4 uses Windows Media Foundation/H.264,
//! avoiding FFmpeg executables, Python and dynamically shipped codec libraries.
use super::{
    capture_native as native,
    capture_runtime::{self as capture, CaptureManager},
};
use gifrecorder::{
    frame_store::{FrameStore, RecordConfig},
    gif_export::{export_gif, GifExportOptions},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub id: String,
    pub format: String,
    pub start: usize,
    pub end: usize,
    pub speed: f32,
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_cursor")]
    pub show_cursor: bool,
    #[serde(default)]
    pub copy: bool,
}
fn default_cursor() -> bool {
    true
}
struct ExportGuard<'a>(&'a AtomicBool);
impl Drop for ExportGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
// An owned modal file dialog must not sit behind the topmost playback surface.
// Restore only the originating session, including when the user cancels.
struct CaptureDialogGuard<'a> {
    app: &'a AppHandle,
    label: &'a str,
    id: &'a str,
}
impl<'a> CaptureDialogGuard<'a> {
    fn begin(app: &'a AppHandle, label: &'a str, id: &'a str) -> Result<Self, String> {
        {
            let manager = app.state::<CaptureManager>();
            let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
            sessions
                .get_mut(label)
                .filter(|s| s.snapshot.id == id)
                .ok_or("录制已关闭")?
                .dialog_open = true;
        }
        let guard = Self { app, label, id };
        let window = app.get_webview_window(label).ok_or("录制窗口已关闭")?;
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        capture::withdraw(app, label);
        Ok(guard)
    }
}
impl Drop for CaptureDialogGuard<'_> {
    fn drop(&mut self) {
        if capture::check(self.app, self.label, self.id).is_err() {
            return;
        }
        if let Some(window) = self.app.get_webview_window(self.label) {
            let _ = window.set_always_on_top(true);
            let _ = window.set_ignore_cursor_events(false);
            let _ = capture::ready(self.app, self.label, self.id);
        }
        if let Ok(mut sessions) = self.app.state::<CaptureManager>().sessions.lock() {
            if let Some(session) = sessions
                .get_mut(self.label)
                .filter(|s| s.snapshot.id == self.id)
            {
                session.dialog_open = false;
            }
        }
    }
}
pub fn export(app: &AppHandle, label: &str, mut request: Export) -> Result<Value, String> {
    capture::check(app, label, &request.id)?;
    if !matches!(request.format.as_str(), "gif" | "mp4" | "auto")
        || !request.speed.is_finite()
        || !(0.1..=8.0).contains(&request.speed)
    {
        return Err("无效的导出设置".into());
    }
    native::Rect {
        x: 0,
        y: 0,
        width: request.width,
        height: request.height,
    }
    .validate()?;
    let manager = app.state::<CaptureManager>();
    if manager.exporting.swap(true, Ordering::AcqRel) {
        return Err("正在导出，请稍候".into());
    }
    let _guard = ExportGuard(&manager.exporting);
    manager.export_cancelled.store(false, Ordering::Release);
    let (frames, sprites, cursors) = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(label)
            .filter(|session| session.snapshot.id == request.id)
            .ok_or("录制已关闭")?;
        if session.recorder.as_ref().is_some_and(|r| !r.is_stopped()) {
            return Err("请先结束录制".into());
        }
        (
            session.frames.clone().ok_or("没有录制帧")?,
            session.cursor.sprites.clone(),
            session.cursor.samples.clone(),
        )
    };
    if frames.frame_count() == 0
        || request.start > request.end
        || request.end >= frames.frame_count()
    {
        return Err("裁剪范围无效".into());
    }
    let path = if request.copy {
        request.format = "gif".into();
        let directory = manager.directory.join("clipboard-recording");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        directory.join(format!("{}.gif", uuid::Uuid::new_v4()))
    } else {
        let window = app.get_webview_window(label).ok_or("录制窗口已关闭")?;
        let dialog_guard = CaptureDialogGuard::begin(app, label, &request.id)?;
        let automatic = request.format == "auto";
        let mut dialog = app
            .dialog()
            .file()
            .set_title("保存录制")
            .set_parent(&window);
        if automatic {
            dialog = dialog
                .add_filter("GIF 动图", &["gif"])
                .add_filter("MP4 视频", &["mp4"]);
        } else {
            dialog = dialog.add_filter(request.format.to_uppercase(), &[request.format.as_str()]);
        }
        let selected = dialog
            .set_file_name(format!(
                "ScreenPilot_{}.{}",
                chrono::Local::now().format("%Y%m%d_%H%M%S"),
                if automatic { "gif" } else { &request.format }
            ))
            .blocking_save_file();
        drop(dialog_guard);
        let Some(path) = selected else {
            return Ok(json!({"cancelled":true}));
        };
        let mut path = path.into_path().map_err(|e| e.to_string())?;
        if automatic {
            request.format = if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
            {
                "mp4"
            } else {
                "gif"
            }
            .into();
        }
        path.set_extension(&request.format);
        path
    };
    // A save dialog can outlive its capture window or a replacement session.
    capture::check(app, label, &request.id)?;
    if manager.export_cancelled.load(Ordering::Acquire) {
        return Ok(json!({"cancelled": true}));
    }
    let temp = path.with_file_name(format!(
        ".screenpilot-{}.{}",
        uuid::Uuid::new_v4(),
        request.format
    ));
    let composed = Arc::new(FrameStore::new(
        request.width,
        request.height,
        frames.fps(),
        RecordConfig {
            jpeg_quality: 100,
            max_frames: 0,
            max_memory_bytes: 1024 * 1024 * 1024,
        },
    ));
    let start_ms = frames.get_elapsed_ms(request.start).unwrap_or(0);
    let result = (|| {
        for index in request.start..=request.end {
            if manager.export_cancelled.load(Ordering::Acquire) {
                return Err("导出已取消".into());
            }
            let rgb = frames.get_frame_rgb(index, 0, 0)?;
            let rgb = image::RgbImage::from_raw(frames.width(), frames.height(), rgb)
                .ok_or("帧尺寸无效")?;
            let mut image = image::DynamicImage::ImageRgb8(rgb).into_rgba8();
            if request.show_cursor {
                super::capture_cursor::compose(
                    &mut image,
                    &sprites,
                    cursors.get(index).or_else(|| cursors.last()),
                );
            }
            let image = image::imageops::resize(
                &image,
                request.width,
                request.height,
                image::imageops::FilterType::Lanczos3,
            );
            let rgb = image::DynamicImage::ImageRgba8(image).into_rgb8();
            if !composed.push_rgb(
                rgb.as_raw(),
                frames
                    .get_elapsed_ms(index)
                    .unwrap_or(start_ms)
                    .saturating_sub(start_ms),
            )? {
                return Err("导出内存达到上限，请缩短录制或降低尺寸".into());
            }
            let _=app.emit_to(label,"capture:export-progress",json!({"stage":"compose","done":index-request.start+1,"total":request.end-request.start+1}));
        }
        if request.format == "gif" {
            let app = app.clone();
            let label = label.to_owned();
            let cancelled = manager.export_cancelled.clone();
            export_gif(
                &composed,
                &GifExportOptions {
                    path: temp.to_string_lossy().into_owned(),
                    width: request.width,
                    height: request.height,
                    repeat: 0,
                    frame_start: 0,
                    frame_end: composed.frame_count() - 1,
                    cursor_sprites: None,
                    cursor_infos: None,
                    speed_multiplier: request.speed,
                },
                Some(Box::new(move |done, total| {
                    let _ = app.emit_to(
                        &label,
                        "capture:export-progress",
                        json!({"stage":"encode","done":done,"total":total}),
                    );
                    !cancelled.load(Ordering::Acquire)
                })),
            )?;
        } else {
            mp4(
                &composed,
                &temp,
                request.speed,
                &manager.export_cancelled,
                |done, total| {
                    let _ = app.emit_to(
                        label,
                        "capture:export-progress",
                        json!({"stage":"encode","done":done,"total":total}),
                    );
                },
            )?;
        }
        if manager.export_cancelled.load(Ordering::Acquire) {
            return Err("导出已取消".into());
        }
        capture::check(app, label, &request.id)?;
        native::replace_file(&temp, &path)?;
        if request.copy {
            let owner = app
                .get_webview_window(label)
                .ok_or("录制已关闭")?
                .hwnd()
                .map_err(|e| e.to_string())?;
            super::capture_platform::copy_file(&path, owner)?;
            prune_clipboard_recordings(path.parent().ok_or("录制缓存路径无效")?, &path);
        }
        Ok(json!({"path":path}))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn prune_clipboard_recordings(directory: &Path, current: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path().extension().is_some_and(|ext| ext == "gif") && entry.path() != current
        })
        .collect();
    files.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
    // File clipboard references must remain valid after the editor closes.
    let excess = files.len().saturating_sub(9);
    for entry in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(entry.path());
    }
}
pub fn mp4(
    frames: &Arc<FrameStore>,
    path: &Path,
    speed: f32,
    cancelled: &AtomicBool,
    progress: impl Fn(usize, usize),
) -> Result<(), String> {
    if frames.frame_count() == 0
        || frames.width() == 0
        || frames.height() == 0
        || !speed.is_finite()
        || !(0.1..=8.0).contains(&speed)
    {
        return Err("录制帧或播放速度无效".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("导出已取消".into());
    }
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            Media::MediaFoundation::*,
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        },
    };
    struct Runtime;
    impl Drop for Runtime {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            CoUninitialize();
            return Err(format!("Windows 媒体组件不可用：{error}"));
        }
        let _runtime = Runtime;
        let result = (|| -> windows::core::Result<()> {
            let width = (frames.width() + 1) & !1;
            let height = (frames.height() + 1) & !1;
            let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let writer = MFCreateSinkWriterFromURL(PCWSTR(path.as_ptr()), None, None)?;
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output.SetUINT32(
                &MF_MT_AVG_BITRATE,
                (width as u64 * height as u64 * frames.fps() as u64 / 5)
                    .clamp(1_000_000, 30_000_000) as u32,
            )?;
            output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            output.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)?;
            output.SetUINT64(
                &MF_MT_FRAME_RATE,
                (((frames.fps() as f32 * speed * 1000.0).round() as u64) << 32) | 1000,
            )?;
            output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            let stream = writer.AddStream(&output)?;
            let input = MFCreateMediaType()?;
            output.CopyAllItems(&input)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width * 4)?;
            writer.SetInputMediaType(stream, &input, None)?;
            writer.BeginWriting()?;
            let timestamps = frames.frame_timestamps();
            for index in 0..frames.frame_count() {
                if cancelled.load(Ordering::Acquire) {
                    return Err(windows::core::Error::from_win32());
                }
                let rgb = frames.get_frame_rgb(index, 0, 0).map_err(|e| {
                    windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e)
                })?;
                let buffer = MFCreateMemoryBuffer(width * height * 4)?;
                let mut pointer = std::ptr::null_mut();
                buffer.Lock(&mut pointer, None, None)?;
                let pixels = std::slice::from_raw_parts_mut(pointer, (width * height * 4) as usize);
                for y in 0..height {
                    for x in 0..width {
                        let source = ((y.min(frames.height() - 1) * frames.width()
                            + x.min(frames.width() - 1))
                            * 3) as usize;
                        // MF_MT_DEFAULT_STRIDE is positive: the encoder consumes top-down RGB32.
                        // Verified by decoding the exported red-top/blue-bottom fixture in Chromium.
                        let target = ((y * width + x) * 4) as usize;
                        pixels[target..target + 4].copy_from_slice(&[
                            rgb[source + 2],
                            rgb[source + 1],
                            rgb[source],
                            255,
                        ]);
                    }
                }
                buffer.Unlock()?;
                buffer.SetCurrentLength(width * height * 4)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                let time = timestamps[index] as f64 * 10000.0 / speed as f64;
                let duration = timestamps
                    .get(index + 1)
                    .map(|t| t.saturating_sub(timestamps[index]))
                    .unwrap_or(1000 / frames.fps().max(1))
                    .max(1) as f64
                    * 10000.0
                    / speed as f64;
                sample.SetSampleTime(time as i64)?;
                sample.SetSampleDuration(duration as i64)?;
                writer.WriteSample(stream, &sample)?;
                progress(index + 1, frames.frame_count());
            }
            writer.Finalize()?;
            Ok(())
        })();
        result.map_err(|e| {
            if cancelled.load(Ordering::Acquire) {
                "导出已取消".into()
            } else {
                format!("H.264 导出失败：{e}")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Arc<FrameStore> {
        let frames = Arc::new(FrameStore::new(
            161,
            121,
            10,
            RecordConfig {
                jpeg_quality: 100,
                max_frames: 30,
                max_memory_bytes: 8 * 1024 * 1024,
            },
        ));
        for index in 0..20 {
            let mut rgb = vec![0; 161 * 121 * 3];
            for y in 0..121 {
                for x in 0..161 {
                    let color = if y < 60 { [230, 20, 20] } else { [20, 30, 230] };
                    rgb[(y * 161 + x) * 3..(y * 161 + x + 1) * 3].copy_from_slice(&color);
                }
            }
            assert!(frames.push_rgb(&rgb, index * 100).unwrap());
        }
        frames
    }
    #[test]
    fn capture_native_media_foundation_and_gif_encode_odd_dimensions() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = std::env::var_os("SCREENPILOT_CAPTURE_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| temporary.path().to_owned());
        std::fs::create_dir_all(&directory).unwrap();
        let frames = fixture();
        let video = directory.join("native-odd.mp4");
        mp4(&frames, &video, 1.0, &AtomicBool::new(false), |_, _| {}).unwrap();
        let bytes = std::fs::read(&video).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        assert!(bytes.len() > 1000);
        export_gif(
            &frames,
            &GifExportOptions {
                path: directory
                    .join("native-odd.gif")
                    .to_string_lossy()
                    .into_owned(),
                width: 161,
                height: 121,
                repeat: 0,
                frame_start: 0,
                frame_end: 19,
                cursor_sprites: None,
                cursor_infos: None,
                speed_multiplier: 1.0,
            },
            None,
        )
        .unwrap();
        let gif = std::fs::read(directory.join("native-odd.gif")).unwrap();
        assert_eq!(&gif[..6], b"GIF89a");
        let cancelled = directory.join("cancelled.mp4");
        std::fs::write(&cancelled, b"existing destination").unwrap();
        assert!(mp4(&frames, &cancelled, 1.0, &AtomicBool::new(true), |_, _| {}).is_err());
        assert_eq!(std::fs::read(&cancelled).unwrap(), b"existing destination");
        assert!(mp4(
            &frames,
            &cancelled,
            f32::NAN,
            &AtomicBool::new(false),
            |_, _| {}
        )
        .is_err());
    }
    use std::path::PathBuf;
}
