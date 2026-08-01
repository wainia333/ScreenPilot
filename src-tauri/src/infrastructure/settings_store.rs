use crate::domain::settings::AppSettings;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("settings.json"),
        }
    }

    pub fn load(&self) -> Result<AppSettings, String> {
        if !self.path.exists() {
            return Ok(AppSettings::default());
        }
        let bytes = fs::read(&self.path).map_err(|error| error.to_string())?;
        let mut settings = serde_json::from_slice::<AppSettings>(&bytes)
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        settings.migrate_prompt_defaults();
        settings.validate()?;
        Ok(settings)
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        settings.validate()?;
        let parent = self.path.parent().ok_or("Settings path has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.next");
        let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if self.path.exists() {
            let backup = self.path.with_extension("json.previous");
            if backup.exists() {
                fs::remove_file(&backup).map_err(|error| error.to_string())?;
            }
            fs::rename(&self.path, &backup).map_err(|error| error.to_string())?;
            if let Err(error) = fs::rename(&temporary, &self.path) {
                let _ = fs::rename(&backup, &self.path);
                return Err(error.to_string());
            }
            fs::remove_file(backup).map_err(|error| error.to_string())?;
        } else {
            fs::rename(temporary, &self.path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_rejects_corrupted_json() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let mut settings = AppSettings::default();
        settings.retry.attempts = 5;
        store.save(&settings).expect("save settings");
        assert_eq!(store.load().expect("load settings"), settings);
        fs::write(store.path(), b"{not-json").expect("corrupt file");
        assert!(store
            .load()
            .unwrap_err()
            .starts_with("Settings file is invalid:"));
    }
}
