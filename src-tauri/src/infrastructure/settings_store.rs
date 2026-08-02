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
        let raw = serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        let mut settings = serde_json::from_value::<AppSettings>(raw.clone())
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        settings.migrate_missing_ai_toggles(&raw);
        settings.migrate_prompt_defaults();
        settings.validate()?;
        Ok(settings)
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        let mut normalized = settings.clone();
        normalized.normalize_ai_options();
        normalized.validate()?;
        let parent = self.path.parent().ok_or("Settings path has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.next");
        let bytes = serde_json::to_vec_pretty(&normalized).map_err(|error| error.to_string())?;
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

    #[test]
    fn loads_legacy_settings_with_ai_enabled_when_models_are_still_available() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let mut raw = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        raw["providers"] = serde_json::json!([{
            "id": "provider",
            "name": "Provider",
            "baseUrl": "https://example.com/v1",
            "keyCount": 0,
            "availableModels": ["model"],
            "enabledModels": ["model"]
        }]);
        raw["translation"]["method"] = serde_json::json!("ai");
        raw["translation"]["aiModel"] = serde_json::json!({
            "providerId": "provider",
            "model": "model"
        });
        raw["screenshotTranslation"]["ocrMethod"] = serde_json::json!("ai");
        raw["screenshotTranslation"]["ocrModel"] = raw["translation"]["aiModel"].clone();
        raw["screenshotTranslation"]["translationMethod"] = serde_json::json!("ai");
        raw["screenshotTranslation"]["translationModel"] = raw["translation"]["aiModel"].clone();
        raw["translation"]
            .as_object_mut()
            .expect("translation object")
            .remove("aiEnabled");
        raw["screenshotTranslation"]
            .as_object_mut()
            .expect("screenshot object")
            .remove("ocrAiEnabled");
        raw["screenshotTranslation"]
            .as_object_mut()
            .expect("screenshot object")
            .remove("translationAiEnabled");
        fs::write(
            store.path(),
            serde_json::to_vec(&raw).expect("encode settings"),
        )
        .expect("write settings");
        let loaded = store.load().expect("load legacy settings");
        assert!(loaded.translation.ai_enabled);
        assert!(loaded.screenshot_translation.ocr_ai_enabled);
        assert!(loaded.screenshot_translation.translation_ai_enabled);
        assert_eq!(
            loaded.translation.method,
            crate::domain::settings::TranslationMethod::Ai
        );
        assert_eq!(
            loaded.screenshot_translation.ocr_method,
            crate::domain::settings::OcrMethod::Ai
        );
        assert_eq!(
            loaded.screenshot_translation.translation_method,
            crate::domain::settings::TranslationMethod::Ai
        );
    }
}
