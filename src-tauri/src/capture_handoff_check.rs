//! Explicit isolated desktop regression. No ScreenPilot services, shortcuts,
//! single-instance plugin or user configuration are started here.
use crate::application::{
    capture_native as native, capture_pin_handoff as handoff,
    capture_runtime::{Action, Snapshot},
};
use image::RgbaImage;
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

struct Harness {
    snapshot: Snapshot,
    source_snapshot: Snapshot,
    source_ready: Mutex<Option<mpsc::Sender<()>>>,
    cover: Mutex<Option<Arc<handoff::SelectionCover>>>,
    complete: Mutex<Option<mpsc::Sender<Result<Value, String>>>>,
    started: Instant,
}
#[tauri::command]
fn capture_snapshot(app: AppHandle, window: WebviewWindow) -> Snapshot {
    let state = app.state::<Harness>();
    if window.label() == "capture" {
        state.source_snapshot.clone()
    } else {
        state.snapshot.clone()
    }
}
#[tauri::command]
async fn capture_ready(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if window.label() == "capture" {
            native::set_pin_visibility(&window, true)?;
            window.set_focus().map_err(|e| e.to_string())?;
            if let Some(sender) = app.state::<Harness>().source_ready.lock().unwrap().take() {
                let _ = sender.send(());
            }
            return Ok(());
        }
        if app.state::<Harness>().snapshot.id != id {
            return Err("Invalid fixture session".into());
        }
        let cover = app
            .state::<Harness>()
            .cover
            .lock()
            .unwrap()
            .clone()
            .ok_or("Missing fixture cover")?;
        let source = app.get_webview_window("capture").ok_or("Missing source")?;
        native::prepare_pin_visibility(&window, &source, Some(cover.hwnd()?))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn capture_action(
    app: AppHandle,
    window: WebviewWindow,
    request: Action,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Harness>();
        if window.label() == "capture" {
            return Ok(Value::Null);
        }
        match request.action.as_str() {
            "pin_resize" => {
                let v = request.value.ok_or("Missing fixture size")?;
                let position = window.outer_position().map_err(|e| e.to_string())?;
                window.set_position(PhysicalPosition::new(position.x + v["dx"].as_i64().unwrap_or(0) as i32, position.y + v["dy"].as_i64().unwrap_or(0) as i32)).map_err(|e|e.to_string())?;
                window.set_size(PhysicalSize::new(v["width"].as_u64().unwrap() as u32,v["height"].as_u64().unwrap() as u32)).map_err(|e|e.to_string())?;
            }
            "pin_interaction" => native::set_hit_regions(&window, &serde_json::from_value::<Vec<native::Rect>>(request.value.ok_or("Missing fixture regions")?).map_err(|e|e.to_string())?)?,
            "pin_presented" => {
                let result = (|| {
                    let cover = state.cover.lock().unwrap().clone().ok_or("Missing fixture cover")?;
                    let area = request.rect.ok_or("Missing fixture picture")?;
                    let opacity = request.value.as_ref().and_then(|v| v["opacity"].as_f64()).unwrap_or(1.0);
                    let mut samples = 0;
                    let probe_start = Instant::now();
                    // Exercise the real handoff's foreground activation while
                    // the destination canvas deliberately has not painted yet.
                    window.set_focus().map_err(|e| e.to_string())?;
                    let attempts = handoff::wait_painted(&window, area, &cover.image, opacity, || {
                        let pixels = native::capture(state.snapshot.bounds, "mss")?;
                        if pixels != *cover.image { return Err(format!("Visible selected pixels changed before paint: {:?}", pixels.get_pixel(20,20))); }
                        samples += 1; Ok(())
                    }).map_err(|error| {
                        if let (Ok(frame), Ok(size)) = (handoff::preview(&window), window.inner_size()) {
                            let _ = frame.save(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-raster-preview-diagnostic.png"));
                            let samples: Vec<_> = (1..10).map(|i| {
                                let x = (area.x as u32 + area.width*i/10)*frame.width()/size.width;
                                let y = (area.y as u32 + area.height*i/10)*frame.height()/size.height;
                                json!({"point":[x,y], "actual": frame.get_pixel(x.min(frame.width()-1),y.min(frame.height()-1)).0, "expected": cover.image.get_pixel(cover.image.width()*i/10,cover.image.height()*i/10).0})
                            }).collect();
                            format!("{error}; {}",json!({"frame":frame.dimensions(), "window":[size.width,size.height], "area":area,"samples":samples}))
                        } else { error }
                    })?;
                    let source = app.get_webview_window("capture").ok_or("Missing source")?;
                    native::set_pin_visibility(&source, false)?;
                    window.set_focus().map_err(|e| e.to_string())?;
                    native::set_pin_visibility(&window, true)?;
                    // Ownership must survive withdrawing the old source and
                    // activating the final pin, including configured opacity.
                    if native::capture(state.snapshot.bounds, "mss")? != *cover.image {
                        return Err("Selected pixels changed during final focus/withdrawal".into());
                    }
                    cover.close();
                    // A main-thread round trip ensures the native cover was
                    // destroyed before checking the actual destination pixels.
                    let _ = handoff::preview(&window)?;
                    for _ in 0..12 {
                        unsafe { windows::Win32::Graphics::Dwm::DwmFlush().map_err(|e| e.to_string())?; }
                        let visible = native::capture(state.snapshot.bounds, "mss")?;
                        if opacity == 1.0 && visible != *cover.image { return Err("Destination pixels differ after cover removal".into()); }
                    }
                    if attempts < 2 { return Err("Delayed paint fixture did not reject its initial empty frame".into()); }
                    Ok(json!({"attempts": attempts, "unchangedVisibleSamples": samples, "probeMs": probe_start.elapsed().as_millis(), "elapsedMs": state.started.elapsed().as_millis(), "opacity": opacity, "scale": window.scale_factor().map_err(|e|e.to_string())?, "picture": area}))
                })();
                if let Some(sender) = state.complete.lock().unwrap().take() { let _ = sender.send(result.clone()); }
                result?;
            }
            "cancel" | "load_failed" => {
                if let Some(sender) = state.complete.lock().unwrap().take() { let _ = sender.send(Err("Fixture window cancelled/failed to load".into())); }
            }
            _ => {}
        }
        Ok(Value::Null)
    }).await.map_err(|e|e.to_string())?
}

pub fn run() {
    if std::env::args().any(|arg| arg == "--click") {
        crate::capture_click_check::run(false);
        return;
    }
    let opacity: f64 = std::env::args()
        .find_map(|arg| arg.strip_prefix("--opacity=").and_then(|s| s.parse().ok()))
        .unwrap_or(1.0);
    let bounds = native::Rect {
        x: 80,
        y: 80,
        width: 240,
        height: 160,
    };
    let image = RgbaImage::from_fn(bounds.width, bounds.height, |x, y| {
        image::Rgba([
            ((x * 13) % 251) as u8,
            ((y * 17) % 253) as u8,
            ((x + y) % 255) as u8,
            255,
        ])
    });
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("domain/capture-settings-schema.json")).unwrap();
    let mut options = serde_json::Map::new();
    for field in schema {
        options.insert(
            field["key"].as_str().unwrap().into(),
            field["default"].clone(),
        );
    }
    options.insert("pin_auto_toolbar".into(), json!(false));
    options.insert("pin_rounded_corners".into(), json!(false));
    options.insert("pin_default_opacity".into(), json!(opacity));
    let snapshot = Snapshot {
        id: "native-pin-raster-check".into(),
        mode: "pin".into(),
        bounds,
        screens: vec![native::desktop_rect().unwrap()],
        image: native::data_url(&image).unwrap(),
        options: Value::Object(options),
        tools: json!({}),
        windows: vec![],
        selection: None,
        marks: Value::Null,
        pin_state: None,
        scan_results: None,
        scan_error: None,
    };
    let mut source_image = RgbaImage::from_pixel(720, 480, image::Rgba([45, 57, 69, 255]));
    image::imageops::replace(
        &mut source_image,
        &image,
        i64::from(bounds.x),
        i64::from(bounds.y),
    );
    let mut source_snapshot = Snapshot {
        mode: "image".into(),
        bounds: native::Rect {
            x: 0,
            y: 0,
            width: 720,
            height: 480,
        },
        image: native::data_url(&source_image).unwrap(),
        selection: Some(bounds),
        ..snapshot.clone()
    };
    source_snapshot.options["magnifier_enabled"] = json!(false);
    let (source_sender, source_receiver) = mpsc::channel();
    let (sender, receiver) = mpsc::channel();
    tauri::Builder::default()
        .manage(Harness { snapshot, source_snapshot, source_ready: Mutex::new(Some(source_sender)), cover: Mutex::new(None), complete: Mutex::new(Some(sender)), started: Instant::now() })
        .invoke_handler(tauri::generate_handler![capture_snapshot, capture_ready, capture_action])
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<Value, String> {
                    let source = WebviewWindowBuilder::new(&handle, "capture", WebviewUrl::App("index.html?route=capture&window=capture".into()))
                        .transparent(true).background_color(tauri::window::Color(0,0,0,0)).decorations(false).shadow(false).always_on_top(true).skip_taskbar(true).visible(false).focused(false).content_protected(true)
                        .data_directory(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-raster-webview-profile"))
                        .build().map_err(|e| e.to_string())?;
                    source.set_position(PhysicalPosition::new(0, 0)).map_err(|e| e.to_string())?;
                    source.set_size(PhysicalSize::new(720, 480)).map_err(|e| e.to_string())?;
                    native::set_pin_visibility(&source, true)?;
                    source_receiver.recv_timeout(Duration::from_secs(20)).map_err(|_| "Source did not paint".to_string())?;
                    handoff::wait_painted(&source, bounds, &image, 1.0, || Ok(()))
                        .map_err(|e| format!("Source raster: {e}"))?;
                    let cover = handoff::SelectionCover::show(&handle, bounds, image)?;
                    native::retain_pin_selection(&source, cover.hwnd()?, bounds)?;
                    if native::capture(bounds, "mss")? != *cover.image {
                        return Err("Selected pixels changed when source controls were removed".into());
                    }
                    *handle.state::<Harness>().cover.lock().unwrap() = Some(cover);
                    let window = WebviewWindowBuilder::new(&handle, "capture-pin-raster-check", WebviewUrl::App("index.html?window=capture-pin-raster-check".into()))
                        .transparent(true).background_color(tauri::window::Color(0,0,0,0)).decorations(false).shadow(false).always_on_top(true).skip_taskbar(true).visible(false).focused(false)
                        .data_directory(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.task/pin-raster-webview-profile"))
                        .initialization_script("(() => { const draw = CanvasRenderingContext2D.prototype.drawImage; CanvasRenderingContext2D.prototype.drawImage = function(...args) { if (this.canvas.parentElement?.classList.contains('jt-pin-document')) { const ctx = this; setTimeout(() => draw.apply(ctx, args), 500); } else draw.apply(this, args); }; })()")
                        .build().map_err(|e|e.to_string())?;
                    crate::application::lifecycle::disable_capture_window_transitions(window.hwnd().map_err(|e|e.to_string())?)?;
                    window.set_position(PhysicalPosition::new(bounds.x-12,bounds.y-12)).map_err(|e|e.to_string())?;
                    window.set_size(PhysicalSize::new(bounds.width+24,bounds.height+24)).map_err(|e|e.to_string())?;
                    receiver.recv_timeout(Duration::from_secs(25)).map_err(|_| "Isolated WebView check timed out".to_string())?
                })();
                if let Some(cover) = handle.state::<Harness>().cover.lock().unwrap().take() { cover.close(); }
                println!("{}", serde_json::to_string(&result).unwrap());
                handle.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .run(tauri::generate_context!()).expect("Isolated WebView regression could not start");
}

pub fn run_click_manual() {
    crate::capture_click_check::run(true);
}
