use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::{ImageFormat, RgbaImage};
use std::fs;
use std::path::{Path, PathBuf};
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
}
