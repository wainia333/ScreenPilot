use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use image::{ImageFormat, RgbaImage};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

#[derive(Clone)]
pub struct ImageStore {
    temporary: PathBuf,
    history: PathBuf,
}

impl ImageStore {
    pub fn new(data_directory: &Path, cache_directory: &Path) -> Result<Self, String> {
        let temporary = cache_directory.join("screenpilot-captures");
        let history = data_directory.join("screenpilot-history-images");
        fs::create_dir_all(&temporary).map_err(|error| error.to_string())?;
        fs::create_dir_all(&history).map_err(|error| error.to_string())?;
        Ok(Self { temporary, history })
    }

    pub fn save_temporary(&self, image: &RgbaImage) -> Result<String, String> {
        let image_id = Uuid::new_v4().to_string();
        image
            .save_with_format(
                self.temporary.join(format!("{image_id}.png")),
                ImageFormat::Png,
            )
            .map_err(|error| error.to_string())?;
        Ok(image_id)
    }

    pub fn archive(&self, image: &RgbaImage, directory: &Path) -> Result<PathBuf, String> {
        if directory.as_os_str().is_empty() {
            return Err("Screenshot archive directory is empty".into());
        }
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "Unable to create screenshot archive directory {}: {error}",
                directory.display()
            )
        })?;
        if !directory
            .metadata()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err(format!(
                "Screenshot archive path is not a directory: {}",
                directory.display()
            ));
        }
        let path = directory.join(format!(
            "ScreenPilot-{}-{}.png",
            Utc::now().format("%Y%m%d-%H%M%S%.3f"),
            Uuid::new_v4().simple()
        ));
        image
            .save_with_format(&path, ImageFormat::Png)
            .map_err(|error| {
                format!(
                    "Unable to archive screenshot to {}: {error}",
                    path.display()
                )
            })?;
        Ok(path)
    }

    pub fn read_data_url(&self, image_id: &str) -> Result<String, String> {
        let bytes = fs::read(self.resolve(image_id)?).map_err(|error| error.to_string())?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    }

    pub fn read_bytes(&self, image_id: &str) -> Result<Vec<u8>, String> {
        fs::read(self.resolve(image_id)?).map_err(|error| error.to_string())
    }

    pub fn commit(&self, image_id: &str) -> Result<(), String> {
        validate_id(image_id)?;
        let source = self.temporary.join(format!("{image_id}.png"));
        let target = self.history.join(format!("{image_id}.png"));
        if target.exists() {
            return Ok(());
        }
        fs::rename(source, target).map_err(|error| error.to_string())
    }

    pub fn delete(&self, image_id: &str) -> Result<(), String> {
        validate_id(image_id)?;
        for directory in [&self.temporary, &self.history] {
            let path = directory.join(format!("{image_id}.png"));
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub fn delete_temporary(&self, image_id: &str) -> Result<(), String> {
        validate_id(image_id)?;
        let path = self.temporary.join(format!("{image_id}.png"));
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn clear_stale_temporary(&self, minimum_age: Duration) -> Result<usize, String> {
        self.clear_stale_temporary_at(minimum_age, SystemTime::now())
    }

    fn clear_stale_temporary_at(
        &self,
        minimum_age: Duration,
        now: SystemTime,
    ) -> Result<usize, String> {
        let entries = fs::read_dir(&self.temporary).map_err(|error| {
            format!(
                "Unable to inspect temporary screenshot directory {}: {error}",
                self.temporary.display()
            )
        })?;
        let mut removed = 0;
        let mut failures = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    failures.push(error.to_string());
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            let is_capture = metadata.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| Uuid::parse_str(stem).is_ok());
            if !is_capture {
                continue;
            }
            let modified = match metadata.modified() {
                Ok(modified) => modified,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            let stale = now
                .duration_since(modified)
                .ok()
                .is_some_and(|age| age >= minimum_age);
            if !stale {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        if failures.is_empty() {
            Ok(removed)
        } else {
            Err(format!(
                "Removed {removed} stale temporary screenshot(s), but cleanup failed for: {}",
                failures.join("; ")
            ))
        }
    }

    fn resolve(&self, image_id: &str) -> Result<PathBuf, String> {
        validate_id(image_id)?;
        let temporary = self.temporary.join(format!("{image_id}.png"));
        if temporary.exists() {
            return Ok(temporary);
        }
        let history = self.history.join(format!("{image_id}.png"));
        if history.exists() {
            return Ok(history);
        }
        Err("Image does not exist".into())
    }
}

fn validate_id(image_id: &str) -> Result<Uuid, String> {
    Uuid::parse_str(image_id).map_err(|_| "Image id is invalid".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_and_commits_history_images() {
        let data = tempfile::tempdir().expect("data directory");
        let cache = tempfile::tempdir().expect("cache directory");
        let store = ImageStore::new(data.path(), cache.path()).expect("image store");
        assert_eq!(
            store.read_data_url("../settings").unwrap_err(),
            "Image id is invalid"
        );
        let image_id = store
            .save_temporary(&RgbaImage::new(20, 20))
            .expect("save image");
        store.commit(&image_id).expect("commit image");
        assert!(store
            .read_data_url(&image_id)
            .expect("read image")
            .starts_with("data:image/png;base64,"));
        store.delete(&image_id).expect("delete image");
        assert_eq!(
            store.read_data_url(&image_id).unwrap_err(),
            "Image does not exist"
        );
    }

    #[test]
    fn targeted_temporary_delete_is_idempotent_and_never_deletes_history() {
        let data = tempfile::tempdir().expect("data directory");
        let cache = tempfile::tempdir().expect("cache directory");
        let store = ImageStore::new(data.path(), cache.path()).expect("image store");
        let temporary_id = store
            .save_temporary(&RgbaImage::new(2, 2))
            .expect("save temporary image");
        let history_id = store
            .save_temporary(&RgbaImage::new(3, 3))
            .expect("save history image");
        store.commit(&history_id).expect("commit history image");

        store
            .delete_temporary(&temporary_id)
            .expect("delete temporary image");
        store
            .delete_temporary(&temporary_id)
            .expect("repeat temporary delete");
        assert_eq!(
            store.read_data_url(&temporary_id).unwrap_err(),
            "Image does not exist"
        );
        store
            .delete_temporary(&history_id)
            .expect("history-only id is a successful no-op");
        assert!(store.read_data_url(&history_id).is_ok());
    }

    #[test]
    fn stale_cleanup_removes_only_aged_uuid_temporary_pngs() {
        let data = tempfile::tempdir().expect("data directory");
        let cache = tempfile::tempdir().expect("cache directory");
        let store = ImageStore::new(data.path(), cache.path()).expect("image store");
        let stale_id = store
            .save_temporary(&RgbaImage::new(2, 2))
            .expect("save stale image");
        let history_id = store
            .save_temporary(&RgbaImage::new(3, 3))
            .expect("save history image");
        store.commit(&history_id).expect("commit history image");
        let unrelated = store.temporary.join("not-a-capture.png");
        fs::write(&unrelated, b"unrelated").expect("write unrelated png");
        let modified = fs::metadata(store.temporary.join(format!("{stale_id}.png")))
            .and_then(|metadata| metadata.modified())
            .expect("read capture timestamp");
        let simulated_now = modified + Duration::from_secs(86_401);

        assert_eq!(
            store
                .clear_stale_temporary_at(Duration::from_secs(86_400), simulated_now)
                .expect("clear stale images"),
            1
        );
        assert_eq!(
            store.read_data_url(&stale_id).unwrap_err(),
            "Image does not exist"
        );
        assert!(store.read_data_url(&history_id).is_ok());
        assert!(unrelated.exists());
    }

    #[test]
    fn stale_cleanup_preserves_recent_temporary_images() {
        let data = tempfile::tempdir().expect("data directory");
        let cache = tempfile::tempdir().expect("cache directory");
        let store = ImageStore::new(data.path(), cache.path()).expect("image store");
        let recent_id = store
            .save_temporary(&RgbaImage::new(2, 2))
            .expect("save recent image");

        assert_eq!(
            store
                .clear_stale_temporary(Duration::from_secs(86_400))
                .expect("inspect recent images"),
            0
        );
        assert!(store.read_data_url(&recent_id).is_ok());
    }

    #[test]
    fn archives_with_unique_names_and_reports_invalid_directories() {
        let data = tempfile::tempdir().expect("data directory");
        let cache = tempfile::tempdir().expect("cache directory");
        let archive = tempfile::tempdir().expect("archive directory");
        let store = ImageStore::new(data.path(), cache.path()).expect("image store");
        let image = RgbaImage::new(4, 4);

        let first = store
            .archive(&image, archive.path())
            .expect("first archive");
        let second = store
            .archive(&image, archive.path())
            .expect("second archive");
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());

        let not_a_directory = archive.path().join("file");
        fs::write(&not_a_directory, b"file").expect("write file");
        assert!(store.archive(&image, &not_a_directory).is_err());
    }
}
