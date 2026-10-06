//! Durable active pins in the application's data directory.
use super::capture_native::{self as native, Rect};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub zoom: f64,
    pub rotation: u16,
    pub flip_h: bool,
    pub flip_v: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Offset {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub rect: CropRect,
    pub scale: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionFrame {
    pub width: f64,
    pub color: String,
    pub radius: f64,
}
impl SelectionFrame {
    pub fn validate(&self) -> Result<(), String> {
        if !self.width.is_finite()
            || !(1.0..=20.0).contains(&self.width)
            || !self.radius.is_finite()
            || !(0.0..=4096.0).contains(&self.radius)
            || !matches!(self.color.len(), 7 | 9)
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("钉图选区边框无效".into());
        }
        Ok(())
    }
    pub fn padding(&self) -> u32 {
        (self.width / 2.0).ceil() as u32 + 1
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub view: View,
    pub crop: Option<Crop>,
    pub opacity: f64,
    pub toolbar: bool,
    pub marks: Value,
    pub offset: Offset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<SelectionFrame>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub id: uuid::Uuid,
    pub bounds: Rect,
    pub state: State,
}
impl State {
    pub fn size(&self, bounds: Rect) -> (f64, f64) {
        if let Some(crop) = &self.crop {
            (crop.rect.width * crop.scale, crop.rect.height * crop.scale)
        } else if self.view.rotation.is_multiple_of(180) {
            (
                f64::from(bounds.width) * self.view.zoom,
                f64::from(bounds.height) * self.view.zoom,
            )
        } else {
            (
                f64::from(bounds.height) * self.view.zoom,
                f64::from(bounds.width) * self.view.zoom,
            )
        }
    }
    pub fn validate(&self, bounds: Rect) -> Result<(), String> {
        if let Some(frame) = &self.frame {
            frame.validate()?;
        }
        let range = |v: f64, min: f64, max: f64| v.is_finite() && (min..=max).contains(&v);
        if !range(self.view.zoom, 0.05, 10.0)
            || ![0, 90, 180, 270].contains(&self.view.rotation)
            || !range(self.opacity, 0.1, 1.0)
            || !range(self.offset.x, 0.0, 32768.0)
            || !range(self.offset.y, 0.0, 32768.0)
        {
            return Err("钉图属性无效".into());
        }
        if let Some(crop) = &self.crop {
            let r = &crop.rect;
            if !range(crop.scale, 0.05, 10.0)
                || !range(r.x, 0.0, f64::from(bounds.width))
                || !range(r.y, 0.0, f64::from(bounds.height))
                || !range(r.width, 1.0, f64::from(bounds.width).max(100.0))
                || !range(r.height, 1.0, f64::from(bounds.height).max(100.0))
            {
                return Err("钉图缩略区域无效".into());
            }
        }
        crate::domain::capture::validate_marks(&self.marks)?;
        Ok(())
    }
}
impl Record {
    pub fn new(bounds: Rect, screen: Rect, marks: Value, opacity: f64, toolbar: bool) -> Self {
        let zoom = if bounds.width <= screen.width && bounds.height <= screen.height {
            1.0
        } else {
            (f64::from(screen.width.saturating_sub(80)) / f64::from(bounds.width))
                .min(f64::from(screen.height.saturating_sub(100)) / f64::from(bounds.height))
                .clamp(0.05, 1.0)
        };
        Self {
            version: 1,
            id: uuid::Uuid::new_v4(),
            bounds,
            state: State {
                view: View {
                    zoom,
                    rotation: 0,
                    flip_h: false,
                    flip_v: false,
                },
                crop: None,
                opacity,
                toolbar,
                marks,
                offset: Offset { x: 12.0, y: 12.0 },
                frame: None,
            },
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("钉图配置版本不兼容".into());
        }
        self.bounds.validate()?;
        if self.bounds.x.unsigned_abs() > 100000 || self.bounds.y.unsigned_abs() > 100000 {
            return Err("钉图位置无效".into());
        }
        self.state.validate(self.bounds)
    }
    pub fn window_bounds(&self) -> Rect {
        let (width, height) = self.state.size(self.bounds);
        Rect {
            x: self.bounds.x - 12,
            y: self.bounds.y - 12,
            width: (width.ceil() as u32).saturating_add(24).clamp(1, 32768),
            height: (height.ceil() as u32).saturating_add(24).clamp(1, 32768),
        }
    }
    pub fn keep_visible(&mut self, screens: &[Rect]) {
        let (width, height) = self.state.size(self.bounds);
        let visible = screens.iter().any(|s| {
            f64::from(self.bounds.x).max(f64::from(s.x)) + 24.0
                <= (f64::from(self.bounds.x) + width).min(f64::from(s.x) + f64::from(s.width))
                && f64::from(self.bounds.y).max(f64::from(s.y)) + 24.0
                    <= (f64::from(self.bounds.y) + height).min(f64::from(s.y) + f64::from(s.height))
        });
        if !visible {
            if let Some(s) = screens.first() {
                self.bounds.x = s.x + 24;
                self.bounds.y = s.y + 24;
            }
        }
    }
}
pub struct Store {
    pub directory: PathBuf,
    legacy: PathBuf,
}
impl Store {
    pub fn new(data: &Path, configuration: &Path) -> Self {
        Self {
            directory: data.join("ScreenPilot-pins"),
            legacy: configuration.join("ScreenPilot-pins"),
        }
    }
    fn migrate(&self) -> Result<(), String> {
        if self.legacy == self.directory {
            return Ok(());
        }
        let entries = match std::fs::read_dir(&self.legacy) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("旧钉图目录读取失败：{e}")),
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let Ok(id) = uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            // Do not traverse links or touch unrelated user directories.
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            std::fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
            let target = self.folder(id);
            let target = if target.exists() {
                // Prefer the current data record. Preserve conflicting old assets
                // under a non-UUID archive so they cannot resurrect a closed pin.
                self.directory
                    .join(format!("{id}.legacy-{}", uuid::Uuid::new_v4()))
            } else {
                target
            };
            std::fs::rename(entry.path(), target)
                .map_err(|e| format!("钉图迁移失败，原文件已保留：{e}"))?;
        }
        // Only remove an empty legacy root. Unknown files are always preserved.
        let _ = std::fs::remove_dir(&self.legacy);
        Ok(())
    }
    fn folder(&self, id: uuid::Uuid) -> PathBuf {
        self.directory.join(id.to_string())
    }
    pub fn create(&self, record: &Record, image: &RgbaImage) -> Result<(), String> {
        record.validate()?;
        let folder = self.folder(record.id);
        native::save(image, &folder.join("image.png"), 100)?;
        self.save(record)
    }
    pub fn save(&self, record: &Record) -> Result<(), String> {
        record.validate()?;
        let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
        if bytes.len() > 8_000_000 {
            return Err("钉图属性数据过大".into());
        }
        native::atomic_write(&self.folder(record.id).join("state.json"), &bytes)
    }
    pub fn remove(&self, id: uuid::Uuid) -> Result<(), String> {
        let folder = self.folder(id);
        // Only remove our two named assets, never unrelated files in the folder.
        for name in ["state.json", "image.png"] {
            match std::fs::remove_file(folder.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        let _ = std::fs::remove_dir(folder);
        Ok(())
    }
    pub fn load(&self) -> Result<(Vec<(Record, RgbaImage)>, usize), String> {
        self.migrate()?;
        let entries = match std::fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
            Err(e) => return Err(e.to_string()),
        };
        let mut pins = Vec::new();
        let mut failures = 0;
        for entry in entries.flatten() {
            let Ok(id) = uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            if entry.file_type().map_or(true, |kind| !kind.is_dir()) {
                continue;
            }
            let loaded = (|| -> Result<(Record, RgbaImage), String> {
                let path = entry.path().join("state.json");
                if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8_000_000 {
                    return Err("钉图属性过大".into());
                }
                let mut record: Record =
                    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                let removed = if let Some(marks) = record.state.marks.as_array_mut() {
                    let count = marks.len();
                    marks.retain(|mark| mark["tool"] != "highlighter");
                    count != marks.len()
                } else {
                    false
                };
                record.validate()?;
                if record.id != id {
                    return Err("钉图标识不匹配".into());
                }
                let path = entry.path().join("image.png");
                let reader = image::ImageReader::open(&path).map_err(|e| e.to_string())?;
                let image = reader.decode().map_err(|e| e.to_string())?.into_rgba8();
                if image.dimensions() != (record.bounds.width, record.bounds.height) {
                    return Err("钉图图片尺寸不匹配".into());
                }
                if removed {
                    self.save(&record)?;
                }
                Ok((record, image))
            })();
            match loaded {
                Ok(pin) => pins.push(pin),
                Err(_) => failures += 1,
            }
        }
        pins.sort_by_key(|(record, _)| record.id);
        Ok((pins, failures))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample_record() -> Record {
        Record::new(
            Rect {
                x: 120,
                y: 180,
                width: 40,
                height: 60,
            },
            Rect {
                width: 1920,
                height: 1080,
                ..Default::default()
            },
            serde_json::json!([]),
            0.75,
            false,
        )
    }
    #[test]
    fn selection_frame_survives_restart_and_old_pins_remain_compatible() {
        let mut record = sample_record();
        let legacy = serde_json::to_vec(&record).unwrap();
        assert!(serde_json::from_slice::<Record>(&legacy)
            .unwrap()
            .state
            .frame
            .is_none());
        record.state.frame = Some(SelectionFrame {
            width: 4.0,
            color: "#3388ff".into(),
            radius: 16.0,
        });
        record.validate().unwrap();
        let restored: Record =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(restored.state.frame.as_ref().unwrap().padding(), 3);
        assert_eq!(restored.state.frame.as_ref().unwrap().color, "#3388ff");
        record.state.frame.as_mut().unwrap().width = f64::NAN;
        assert!(record.validate().is_err());
    }
    #[test]
    fn legacy_pins_move_into_data_and_retain_pixels_geometry_and_unknown_assets() {
        let root = tempfile::tempdir().unwrap();
        let legacy = Store::new(root.path(), root.path());
        let record = sample_record();
        let image = RgbaImage::from_pixel(40, 60, image::Rgba([11, 22, 33, 255]));
        legacy.create(&record, &image).unwrap();
        std::fs::write(legacy.folder(record.id).join("user.txt"), "preserve").unwrap();
        let data = root.path().join("ScreenPilot-data");
        let store = Store::new(&data, root.path());
        let (loaded, failed) = store.load().unwrap();
        assert_eq!(store.directory, data.join("ScreenPilot-pins"));
        assert_eq!(failed, 0);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1, image);
        assert_eq!(loaded[0].0.bounds.x, 120);
        assert_eq!(loaded[0].0.bounds.y, 180);
        assert_eq!(loaded[0].0.state.opacity, 0.75);
        assert_eq!(
            std::fs::read_to_string(store.folder(record.id).join("user.txt")).unwrap(),
            "preserve"
        );
        assert!(!legacy.directory.exists());
        assert_eq!(store.load().unwrap().0.len(), 1);
        store.remove(record.id).unwrap();
        assert!(store.load().unwrap().0.is_empty());
    }
    #[test]
    fn conflicting_legacy_pin_is_archived_without_overwriting_or_resurrecting_current_record() {
        let root = tempfile::tempdir().unwrap();
        let legacy = Store::new(root.path(), root.path());
        let store = Store::new(&root.path().join("ScreenPilot-data"), root.path());
        let mut record = sample_record();
        legacy
            .create(
                &record,
                &RgbaImage::from_pixel(40, 60, image::Rgba([1, 2, 3, 255])),
            )
            .unwrap();
        std::fs::write(legacy.directory.join("notes.txt"), "unrelated").unwrap();
        record.bounds.x = 456;
        let current = RgbaImage::from_pixel(40, 60, image::Rgba([4, 5, 6, 255]));
        store.create(&record, &current).unwrap();
        let (loaded, failed) = store.load().unwrap();
        assert_eq!(failed, 0);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0.bounds.x, 456);
        assert_eq!(loaded[0].1, current);
        assert!(!legacy.folder(record.id).exists());
        assert!(legacy.directory.join("notes.txt").exists());
        let archive = std::fs::read_dir(&store.directory)
            .unwrap()
            .flatten()
            .find(|e| e.file_name().to_string_lossy().contains(".legacy-"))
            .unwrap()
            .path();
        assert!(archive.join("image.png").exists());
        assert!(archive.join("state.json").exists());
        store.remove(record.id).unwrap();
        assert!(store.load().unwrap().0.is_empty());
        assert!(archive.join("image.png").exists());
    }
    #[test]
    fn retired_highlights_are_removed_without_losing_the_pin_image_other_marks_or_position() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(&root.path().join("ScreenPilot-data"), root.path());
        let mut record = sample_record();
        let retained = serde_json::json!({"id":"pen","tool":"pen","rotation":0,"points":[{"x":5,"y":5},{"x":20,"y":20}],"style":{"width":4,"color":"#FF0000"}});
        record.state.marks = serde_json::json!([retained.clone()]);
        let image = RgbaImage::from_pixel(
            record.bounds.width,
            record.bounds.height,
            image::Rgba([22, 33, 44, 255]),
        );
        store.create(&record, &image).unwrap();
        let mut raw = serde_json::to_value(&record).unwrap();
        raw["state"]["marks"].as_array_mut().unwrap().push(serde_json::json!({"id":"old","tool":"highlighter","rotation":0,"points":[{"x":5,"y":10},{"x":30,"y":10}],"style":{"width":15,"color":"#FFFF00"}}));
        let path = store.folder(record.id).join("state.json");
        std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        let (pins, failures) = store.load().unwrap();
        assert_eq!(failures, 0);
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].1, image);
        assert_eq!(pins[0].0.state.marks, serde_json::json!([retained]));
        assert_eq!(pins[0].0.bounds.x, record.bounds.x);
        assert_eq!(pins[0].0.bounds.y, record.bounds.y);
        assert_eq!(pins[0].0.state.opacity, record.state.opacity);
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("highlighter"));
        assert_eq!(store.load().unwrap().0.len(), 1);
    }

    #[test]
    fn pins_round_trip_pixels_marks_and_presentation_and_close_removes_only_its_assets() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(&root.path().join("ScreenPilot-data"), root.path());
        let image = RgbaImage::from_pixel(80, 120, image::Rgba([22, 33, 44, 255]));
        let mut record = Record::new(
            Rect {
                x: -800,
                y: 240,
                width: 80,
                height: 120,
            },
            Rect {
                width: 1920,
                height: 1080,
                ..Default::default()
            },
            serde_json::json!([]),
            0.7,
            false,
        );
        record.state.view.zoom = 1.25;
        record.state.view.rotation = 90;
        record.state.view.flip_h = true;
        store.create(&record, &image).unwrap();
        record.bounds.x = -456;
        record.bounds.y = 345;
        store.save(&record).unwrap();
        let (pins, failed) = store.load().unwrap();
        assert_eq!(failed, 0);
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].1, image);
        assert_eq!(pins[0].0.bounds.x, -456);
        assert_eq!(pins[0].0.state.view.rotation, 90);
        assert!(pins[0].0.state.view.flip_h);
        assert_eq!(pins[0].0.state.opacity, 0.7);
        let other = store.folder(record.id).join("user.txt");
        std::fs::write(&other, "keep").unwrap();
        store.remove(record.id).unwrap();
        assert!(other.exists());
        assert!(!store.folder(record.id).join("image.png").exists());
    }
    #[test]
    fn corrupt_pin_does_not_prevent_other_pins_restoring_and_bad_properties_do_not_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(&root.path().join("ScreenPilot-data"), root.path());
        let image = RgbaImage::new(50, 70);
        let mut record = Record::new(
            Rect {
                x: 10,
                y: 20,
                width: 50,
                height: 70,
            },
            Rect {
                width: 1920,
                height: 1080,
                ..Default::default()
            },
            serde_json::json!([]),
            1.0,
            false,
        );
        store.create(&record, &image).unwrap();
        record.state.view.zoom = f64::NAN;
        assert!(store.save(&record).is_err());
        let bad = store.folder(uuid::Uuid::new_v4());
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("state.json"), "broken").unwrap();
        let (pins, failed) = store.load().unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(failed, 1);
        let mut record = pins[0].0.clone();
        record.bounds.x = -20000;
        record.keep_visible(&[Rect {
            width: 1920,
            height: 1080,
            ..Default::default()
        }]);
        assert_eq!(record.bounds.x, 24);
    }
}
#[test]
fn new_pin_preserves_pixel_size_and_origin_when_selection_fits_monitor() {
    let screen = Rect {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };
    let region = Rect {
        x: -1920,
        y: 0,
        width: 1880,
        height: 1040,
    };
    let record = Record::new(region, screen, serde_json::json!([]), 1.0, false);
    assert_eq!(record.state.view.zoom, 1.0);
    assert_eq!(record.state.size(region), (1880.0, 1040.0));
    assert_eq!(record.window_bounds().x + 12, region.x);
    assert_eq!(record.window_bounds().y + 12, region.y);
    let long = Record::new(
        Rect {
            height: 20000,
            ..region
        },
        screen,
        serde_json::json!([]),
        1.0,
        false,
    );
    assert!(long.state.view.zoom < 1.0);
}
