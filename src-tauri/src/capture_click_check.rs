//! Debug-only React click and native pin handoff regression. Uses isolated
//! settings/storage and omits clipboard/file export side effects.
use crate::application::{
    capture_native::{self as native, Rect},
    capture_pin_handoff as handoff, capture_runtime as runtime,
    state::AppState,
};
use crate::domain::settings::AppSettings;
use crate::infrastructure::{images::ImageStore, settings_store::SettingsStore};
use image::{Rgba, RgbaImage};
use serde_json::json;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
fn capture_snapshot(app: AppHandle, window: WebviewWindow) -> Result<runtime::Snapshot, String> {
    runtime::snapshot(&app, window.label())
}
#[tauri::command]
async fn capture_ready(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || runtime::ready(&app, window.label(), &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn capture_action(
    app: AppHandle,
    window: WebviewWindow,
    request: runtime::Action,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let action = request.action.clone();
        println!(
            "{} begin {action}",
            app.state::<CheckClock>().0.elapsed().as_millis()
        );
        if action == "diagnostic" {
            println!("pin DOM diagnostic: {}", request.value.unwrap_or_default());
            return Ok(serde_json::Value::Null);
        }
        if action == "pin_presented" {
            let probe = format!(r#"(() => {{
              const doc = document.querySelector('.jt-pin-document canvas');
              const frame = document.querySelector('.jt-pin-frame');
              const describe = e => ({{width:e.width,height:e.height,rect:e.getBoundingClientRect().toJSON(),imageRendering:getComputedStyle(e).imageRendering,transform:getComputedStyle(e).transform}});
              window.__TAURI_INTERNALS__.invoke('capture_action', {{request:{{id:{},action:'diagnostic',value:{{dpr:devicePixelRatio,doc:describe(doc),frame:frame?describe(frame):null,pixel:Array.from(doc.getContext('2d').getImageData(64,200,1,1).data)}}}}}});
            }})()"#,serde_json::to_string(&request.id).unwrap());
            window.eval(probe).map_err(|e| e.to_string())?;
            let root =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-click-check");
            let cover = app
                .state::<runtime::CaptureManager>()
                .sessions
                .lock()
                .unwrap()
                .get("capture")
                .and_then(|session| session.pin_cover.clone());
            if let Ok(pixels) = handoff::preview(&window) {
                let _ = pixels.save(root.join("destination-preview.png"));
                println!(
                    "destination preview={:?}, size={:?}, area={:?}",
                    pixels.dimensions(),
                    window.inner_size(),
                    request.rect
                );
            }
            if let Some(cover) = cover {
                let _ = cover.image.save(root.join("retained-selection.png"));
            }
        }
        // Preserve the user's clipboard; all pin preparation, window creation,
        // readiness, presentation and cleanup below use production functions.
        let result = if action == "pin" {
            let mut snapshot = runtime::snapshot(&app, window.label())?;
            snapshot.marks = request.value.unwrap_or_default();
            let image = native::decode(request.pin_image.as_deref().ok_or("No pin image")?)?;
            runtime::pin(
                &app,
                &snapshot,
                &image,
                request.rect.ok_or("No pin rect")?,
                Some(&request.id),
            )
            .map(|()| serde_json::Value::Null)
        } else {
            runtime::action(&app, window.label(), request)
        };
        if action == "pin_presented" && result.is_ok() {
            // Tao rewrites WS_VISIBLE when any window flag changes. Exercise
            // that after presentation: an HWND-only show regresses to hidden.
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            window
                .set_ignore_cursor_events(false)
                .map_err(|e| e.to_string())?;
            if !window.is_visible().map_err(|e| e.to_string())? {
                return Err("Presented pin was hidden by a framework style update".into());
            }
        }
        println!(
            "{} end {action}: {}",
            app.state::<CheckClock>().0.elapsed().as_millis(),
            if let Err(e) = &result {
                e.as_str()
            } else {
                "ok"
            }
        );
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

struct CheckClock(Instant);

// Include both sides of all four borders. Interior-only sampling previously
// passed while the complete selection outline disappeared during preparation.
fn selected_pixels_match(
    actual: &RgbaImage,
    expected: &RgbaImage,
    selection: Rect,
    sample: Rect,
) -> bool {
    let ox = (selection.x - sample.x) as u32;
    let oy = (selection.y - sample.y) as u32;
    for y in 8..selection.height - 8 {
        for x in 8..selection.width - 8 {
            if (selection.x as u32 + x) % 16 == 4
                && (selection.y as u32 + y) % 16 == 4
                && actual
                    .get_pixel(x + ox, y + oy)
                    .0
                    .iter()
                    .zip(expected.get_pixel(x, y).0)
                    .any(|(a, b)| a.abs_diff(b) > 2)
            {
                return false;
            }
        }
    }
    for step in 1..8 {
        let x = ox + selection.width * step / 8;
        let y = oy + selection.height * step / 8;
        for (px, py) in [
            (x, oy - 1),
            (x, oy),
            (x, oy + selection.height - 1),
            (x, oy + selection.height),
            (ox - 1, y),
            (ox, y),
            (ox + selection.width - 1, y),
            (ox + selection.width, y),
        ] {
            if actual
                .get_pixel(px, py)
                .0
                .iter()
                .zip([51_u8, 136, 255, 255])
                // This desktop is at 150% DPI. The source's full-screen
                // canvas blends inner-edge colors by up to 19 levels even
                // before clicking. Keep a bounded raster tolerance while
                // still requiring blue on both sides of every border.
                .any(|(a, b)| a.abs_diff(b) > 24)
            {
                return false;
            }
        }
    }
    true
}

pub fn run(manual: bool) {
    unsafe {
        use windows::Win32::UI::HiDpi::*;
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-click-check");
    let bounds = native::desktop_rect().unwrap();
    let selection = Rect {
        x: 420,
        y: 280,
        width: 640,
        height: 400,
    };
    let mut settings = AppSettings::default();
    settings
        .capture
        .tools
        .insert("lastRegion".into(), json!(selection));
    for (key, value) in [
        ("screenshot_save_enabled", json!(false)),
        ("clipboard_file_reference_enabled", json!(false)),
        ("pin_auto_toolbar", json!(false)),
        ("selection_handle_style", json!("none")),
        ("selection_border_width", json!(4)),
        ("theme_color", json!("#3388ff")),
        ("pin_rounded_corners", json!(false)),
        ("magnifier_enabled", json!(false)),
    ] {
        settings.capture.native_options.insert(key.into(), value);
    }
    let image = RgbaImage::from_fn(bounds.width, bounds.height, |x, y| {
        Rgba([
            ((x / 16 * 13) % 251) as u8,
            ((y / 16 * 17) % 253) as u8,
            ((x / 8 + y / 8) % 255) as u8,
            255,
        ])
    });
    let selected = image::imageops::crop_imm(
        &image,
        (selection.x - bounds.x) as u32,
        (selection.y - bounds.y) as u32,
        selection.width,
        selection.height,
    )
    .to_image();
    let store = SettingsStore::new(&root);
    let images = ImageStore::new(&root.join("data"), &root.join("cache")).unwrap();
    tauri::Builder::default()
        .manage(CheckClock(Instant::now()))
        .manage(AppState::new(store, images, settings, root.join("webview"), root.join("cache")))
        .manage(runtime::CaptureManager::new(root.join("capture"), root.join("data")))
        .invoke_handler(tauri::generate_handler![capture_snapshot, capture_ready, capture_action])
        .setup(move |app| {
            let app = app.handle().clone();
            std::thread::spawn(move || {
                unsafe {
                    use windows::Win32::UI::HiDpi::*;
                    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                }
                let result = (|| -> Result<_, String> {
                    runtime::start_session(&app, "image", Some(selection), Some(image))?;
                    let source = app.get_webview_window("capture").ok_or("Missing source")?;
                    // GDI cannot see a WDA_EXCLUDEFROMCAPTURE source. Disable
                    // protection in this isolated fixture only so sampling can
                    // begin BEFORE clicking, not after the first cover frame.
                    source.show().map_err(|e|e.to_string())?;
                    let area = Rect { x:selection.x-bounds.x,y:selection.y-bounds.y,..selection };
                    handoff::wait_painted(&source, area, &selected, 1.0, || Ok(()))
                        .map_err(|e| {
                            if let Ok(frame)=handoff::preview(&source) { let _=frame.save(root.join("source-preview.png")); }
                            format!("Source: {e}; bounds={bounds:?}; area={area:?}")
                        })?;
                    native::allow_recording_capture(&source)?;
                    native::set_pin_visibility(&source,true)?;
                    let sample = Rect { x:selection.x-3,y:selection.y-3,width:selection.width+6,height:selection.height+6 };
                    let expected = selected;
                    let start = Instant::now();
                    let mut clicked = false;
                    let mut completed = None;
                    let mut samples = 0;
                    let mut gaps = Vec::new();
                    let mut failed_frames = Vec::new();
                    let mut retained_hwnd = None;
                    let mut retained_reference: Option<RgbaImage> = None;
                    let mut retained_mask = None;
                    let mut retained_frames = 0;
                    while start.elapsed() < Duration::from_secs(if manual {180}else{25}) {
                        unsafe { windows::Win32::Graphics::Dwm::DwmFlush().map_err(|e|e.to_string())?; }
                        let pixels = native::capture(sample,"mss")?;
                        let surface = app.state::<runtime::CaptureManager>().sessions.lock().unwrap()
                            .values().find_map(|s| s.pin_cover.clone());
                        if let Some(surface) = surface {
                            let hwnd = surface.hwnd()?.0 as isize;
                            if retained_hwnd.is_some_and(|original| original != hwnd) {
                                return Err("Pin replaced its native pixel surface".into());
                            }
                            retained_hwnd = Some(hwnd);
                            let reference = retained_reference.get_or_insert_with(|| pixels.clone());
                            let mask = retained_mask.get_or_insert_with(|| surface.image.clone());
                            if !pixels.pixels().zip(reference.pixels()).zip(mask.pixels())
                                .all(|((actual, expected), alpha)| alpha[3] != 255 || actual == expected) {
                                failed_frames.push(pixels.clone());
                                gaps.push(start.elapsed().as_millis());
                            }
                            retained_frames += 1;
                        } else if retained_hwnd.is_some() {
                            return Err("Pin removed its native pixel surface after readiness".into());
                        }
                        if samples<2 {
                            println!("sample={samples}; visible={:?}; sourcePos={:?}; bounds={bounds:?}; sample={sample:?}; actual={:?}; expected={:?}",source.is_visible(),source.outer_position(),pixels.get_pixel(0,0),expected.get_pixel(0,0));
                            if samples == 0 {
                                pixels.save(root.join("baseline-frame.png")).map_err(|e|e.to_string())?;
                                println!("border top={:?}; left={:?}; bottom={:?}; right={:?}; interior actual={:?}; wanted={:?}",pixels.get_pixel(83,2),pixels.get_pixel(2,53),pixels.get_pixel(83,403),pixels.get_pixel(643,53),pixels.get_pixel(19,19),expected.get_pixel(16,16));
                            }
                        }
                        if !selected_pixels_match(&pixels, &expected, selection, sample) {
                            if gaps.len() < 8 {
                                failed_frames.push(pixels.clone());
                            }
                            gaps.push(start.elapsed().as_millis());
                        }
                        samples += 1;
                        if !manual && !clicked && samples >= 8 {
                            if !gaps.is_empty() { return Err("Selected pixels are not visible before clicking; desktop check unavailable".into()); }
                            println!("{} click",app.state::<CheckClock>().0.elapsed().as_millis());
                            source.eval("document.querySelector('button[aria-label=\"钉图\"]').click()")
                                .map_err(|e|e.to_string())?;
                            clicked = true;
                        }
                        let done = app.state::<runtime::CaptureManager>().sessions.lock().unwrap()
                            .iter().any(|(label,s)|label.starts_with("capture-pin-") && s.ready);
                        if done {
                            let since = completed.get_or_insert_with(Instant::now);
                            if since.elapsed() > Duration::from_secs(2) { pixels.save(root.join("final-visible.png")).map_err(|e|e.to_string())?; break; }
                        }
                    }
                    for (index,frame) in failed_frames.into_iter().enumerate() {
                        frame.save(root.join(format!("gap-{index}.png"))).map_err(|e|e.to_string())?;
                    }
                    if completed.is_none() { if let Ok(frame)=handoff::preview(&source){let _=frame.save(root.join("final-preview.png"));} }
                    let report = json!({"samples":samples,"retainedFrames":retained_frames,"sameSurface":retained_hwnd.is_some(),"gapCount":gaps.len(),"gapsMs":&gaps[..gaps.len().min(25)],"completed":completed.is_some(),"elapsedMs":start.elapsed().as_millis()});
                    if completed.is_none() || retained_frames < 20 || !gaps.is_empty() { return Err(report.to_string()); }
                    Ok(report)
                })();
                println!("{}",serde_json::to_string(&result).unwrap());
                let report_root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-click-check");
                let _=std::fs::write(report_root.join("result.json"),serde_json::to_string_pretty(&result).unwrap());
                runtime::cancel(&app);
                app.exit(if result.is_ok(){0}else{1});
            });
            Ok(())
        })
        .run(tauri::generate_context!()).expect("Click regression failed to start");
}
