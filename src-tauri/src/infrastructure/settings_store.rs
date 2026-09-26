use crate::domain::settings::AppSettings;
use chrono::Utc;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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
        self.load_path(&self.path)
    }

    fn load_path(&self, path: &Path) -> Result<AppSettings, String> {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        let raw = serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        let mut settings = serde_json::from_value::<AppSettings>(raw.clone())
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        settings.migrate_provider_protocols(&raw);
        settings.migrate_missing_ai_toggles(&raw);
        settings.migrate_prompt_defaults();
        settings.normalize_ai_options();
        // Older releases allowed this invalid combination to be persisted.
        // Disable only the optional archive feature during load so upgrading
        // never quarantines an otherwise valid settings file.
        if settings.general.image_archive_enabled
            && settings.general.image_archive_path.trim().is_empty()
        {
            settings.general.image_archive_enabled = false;
        }
        settings.validate()?;
        Ok(settings)
    }

    pub fn load_or_recover(&self) -> Result<(AppSettings, Option<String>), String> {
        self.load_or_recover_with(|| self.quarantine_invalid())
    }

    fn load_or_recover_with<F>(
        &self,
        preserve_invalid: F,
    ) -> Result<(AppSettings, Option<String>), String>
    where
        F: FnOnce() -> Result<PathBuf, String>,
    {
        if !self
            .path
            .try_exists()
            .map_err(|error| format!("Unable to inspect the settings file: {error}"))?
        {
            return self.recover_interrupted_save(true);
        }
        match self.load() {
            Ok(settings) => Ok((settings, None)),
            Err(load_error) => {
                let preserved = preserve_invalid().map_err(|preserve_error| {
                    format!(
                        "Unable to load settings ({load_error}) and could not preserve the original file: {preserve_error}"
                    )
                })?;
                let preserved_name = preserved
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("settings.invalid.json");
                let invalid_notice = format!(
                    "设置文件无法读取，原文件已保留为“{preserved_name}”。原因：{load_error}"
                );
                let (settings, interrupted_notice) = self.recover_interrupted_save(false)?;
                let notice = match interrupted_notice {
                    Some(interrupted_notice) => {
                        format!("{invalid_notice}\n\n{interrupted_notice}")
                    }
                    None => format!(
                        "{invalid_notice} 本次使用默认设置启动，请确认恢复或重新配置后再保存。"
                    ),
                };
                Ok((settings, Some(notice)))
            }
        }
    }

    fn recover_interrupted_save(
        &self,
        primary_was_missing: bool,
    ) -> Result<(AppSettings, Option<String>), String> {
        let next = ("settings.json.next", self.path.with_extension("json.next"));
        let previous = (
            "settings.json.previous",
            self.path.with_extension("json.previous"),
        );
        let candidates = if primary_was_missing {
            [next, previous]
        } else {
            [previous, next]
        };
        let mut existing = Vec::new();
        for (name, path) in candidates {
            if path.try_exists().map_err(|error| {
                format!(
                    "Unable to inspect interrupted settings candidate {}: {error}",
                    path.display()
                )
            })? {
                existing.push((name, path));
            }
        }
        if existing.is_empty() {
            return Ok((AppSettings::default(), None));
        }

        let mut invalid = Vec::new();
        for (name, path) in &existing {
            match self.load_path(path) {
                Ok(settings) => {
                    let restore_result = self.restore_primary_from(path);
                    let mut notice = format!(
                        "检测到上次设置保存可能在写入过程中中断，主设置文件缺失。已验证并从“{name}”恢复本次设置；保存阶段文件均原样保留。"
                    );
                    if let Err(error) = restore_result {
                        notice.push_str(&format!(
                            " 无法重建 settings.json，本次仍使用已验证的恢复设置：{error}"
                        ));
                    }
                    if !invalid.is_empty() {
                        notice.push_str(&format!(
                            " 已跳过无法通过验证的候选：{}。",
                            invalid.join("；")
                        ));
                    }
                    return Ok((settings, Some(notice)));
                }
                Err(error) => invalid.push(format!("{name}（{error}）")),
            }
        }

        Ok((
            AppSettings::default(),
            Some(format!(
                "检测到上次设置保存可能在写入过程中中断，主设置文件缺失，但保存阶段文件均无法通过验证。本次使用默认设置启动；原文件已保留，请手动检查后再保存。详情：{}",
                invalid.join("；")
            )),
        ))
    }

    fn restore_primary_from(&self, source: &Path) -> Result<(), String> {
        fs::copy(source, &self.path).map_err(|error| {
            format!(
                "unable to copy {} to {}: {error}",
                source.display(),
                self.path.display()
            )
        })?;
        fs::File::open(&self.path)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                format!(
                    "unable to synchronize restored settings {}: {error}",
                    self.path.display()
                )
            })?;
        self.load_path(&self.path).map(|_| ()).map_err(|error| {
            format!(
                "restored settings {} did not pass verification: {error}",
                self.path.display()
            )
        })
    }

    fn quarantine_invalid(&self) -> Result<PathBuf, String> {
        let parent = self.path.parent().ok_or("Settings path has no parent")?;
        let preserved = parent.join(format!(
            "settings.invalid-{}-{}.json",
            Utc::now().timestamp_millis(),
            Uuid::new_v4().simple()
        ));
        fs::rename(&self.path, &preserved).map_err(|error| {
            format!(
                "unable to move {} to {}: {error}",
                self.path.display(),
                preserved.display()
            )
        })?;
        Ok(preserved)
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

    fn write_settings(path: &Path, settings: &AppSettings) {
        fs::write(
            path,
            serde_json::to_vec_pretty(settings).expect("encode settings"),
        )
        .expect("write settings candidate");
    }

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
    fn persists_interface_language_for_the_next_startup() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let mut settings = AppSettings::default();
        settings.language = crate::domain::settings::InterfaceLanguage::En;

        store.save(&settings).expect("save English settings");
        let reloaded = store.load().expect("reload English settings");

        assert_eq!(
            reloaded.language,
            crate::domain::settings::InterfaceLanguage::En
        );
    }

    #[test]
    fn loads_legacy_empty_archive_path_without_quarantining_other_settings() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let mut settings = AppSettings::default();
        settings.retry.attempts = 5;
        settings.general.image_archive_enabled = true;
        settings.general.image_archive_path = "  ".into();
        write_settings(store.path(), &settings);

        let loaded = store.load().expect("load legacy settings");

        assert_eq!(loaded.retry.attempts, 5);
        assert!(!loaded.general.image_archive_enabled);
        assert!(store.path().exists());
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

    #[test]
    fn quarantines_corrupted_settings_before_falling_back_to_defaults() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let corrupted = b"{not-json";
        fs::write(store.path(), corrupted).expect("write corrupt settings");

        let (settings, notice) = store.load_or_recover().expect("recover settings");
        assert_eq!(settings, AppSettings::default());
        assert!(!store.path().exists());
        let preserved = fs::read_dir(directory.path())
            .expect("read settings directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("settings.invalid-") && name.ends_with(".json")
                    })
            })
            .expect("preserved invalid settings");
        assert_eq!(
            fs::read(&preserved).expect("read preserved settings"),
            corrupted
        );
        let notice = notice.expect("recovery notice");
        assert!(notice.contains(
            preserved
                .file_name()
                .and_then(|name| name.to_str())
                .expect("preserved file name")
        ));
        assert!(notice.contains("Settings file is invalid"));
    }

    #[test]
    fn refuses_default_fallback_when_the_invalid_file_cannot_be_preserved() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        fs::write(store.path(), b"{not-json").expect("write corrupt settings");

        let error = store
            .load_or_recover_with(|| Err("access denied".into()))
            .expect_err("fallback must not continue without preservation");
        assert!(error.contains("could not preserve the original file"));
        assert!(error.contains("access denied"));
        assert_eq!(
            fs::read(store.path()).expect("original remains"),
            b"{not-json"
        );
    }

    #[test]
    fn restores_the_synced_next_file_after_a_crash_between_atomic_renames() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let previous_path = store.path().with_extension("json.previous");
        let next_path = store.path().with_extension("json.next");
        let mut previous = AppSettings::default();
        previous.retry.attempts = 2;
        let mut next = AppSettings::default();
        next.retry.attempts = 5;
        write_settings(&previous_path, &previous);
        write_settings(&next_path, &next);

        let (loaded, notice) = store.load_or_recover().expect("recover interrupted save");

        assert_eq!(loaded, next);
        assert_eq!(store.load().expect("load restored primary"), next);
        assert!(previous_path.exists());
        assert!(next_path.exists());
        assert!(notice
            .as_deref()
            .is_some_and(|value| value.contains("settings.json.next")));
    }

    #[test]
    fn falls_back_to_the_valid_previous_file_when_next_is_incomplete() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let previous_path = store.path().with_extension("json.previous");
        let next_path = store.path().with_extension("json.next");
        let mut previous = AppSettings::default();
        previous.retry.attempts = 4;
        write_settings(&previous_path, &previous);
        fs::write(&next_path, b"{incomplete").expect("write incomplete next file");

        let (loaded, notice) = store.load_or_recover().expect("recover previous settings");

        assert_eq!(loaded, previous);
        assert_eq!(store.load().expect("load restored primary"), previous);
        assert_eq!(
            fs::read(&next_path).expect("incomplete next remains"),
            b"{incomplete"
        );
        let notice = notice.expect("recovery notice");
        assert!(notice.contains("settings.json.previous"));
        assert!(notice.contains("settings.json.next"));
    }

    #[test]
    fn quarantines_an_invalid_primary_then_recovers_a_valid_previous_file() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let previous_path = store.path().with_extension("json.previous");
        let next_path = store.path().with_extension("json.next");
        let mut previous = AppSettings::default();
        previous.retry.attempts = 4;
        let mut next = AppSettings::default();
        next.retry.attempts = 5;
        write_settings(&previous_path, &previous);
        write_settings(&next_path, &next);
        fs::write(store.path(), b"{invalid-primary").expect("write invalid primary");

        let (loaded, notice) = store
            .load_or_recover()
            .expect("recover valid previous settings");

        assert_eq!(loaded, previous);
        assert_eq!(store.load().expect("load restored primary"), previous);
        assert!(previous_path.exists());
        assert!(next_path.exists());
        let preserved_invalid = fs::read_dir(directory.path())
            .expect("read settings directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("settings.invalid-"))
            })
            .expect("preserved invalid primary");
        assert_eq!(
            fs::read(preserved_invalid).expect("read preserved invalid primary"),
            b"{invalid-primary"
        );
        let notice = notice.expect("recovery notice");
        assert!(notice.contains("settings.invalid-"));
        assert!(notice.contains("settings.json.previous"));
    }

    #[test]
    fn preserves_invalid_crash_stage_files_and_reports_default_fallback() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let previous_path = store.path().with_extension("json.previous");
        let next_path = store.path().with_extension("json.next");
        fs::write(&previous_path, b"{invalid-previous").expect("write invalid previous");
        fs::write(&next_path, b"{invalid-next").expect("write invalid next");

        let (loaded, notice) = store.load_or_recover().expect("report invalid candidates");

        assert_eq!(loaded, AppSettings::default());
        assert!(!store.path().exists());
        assert_eq!(
            fs::read(&previous_path).expect("previous remains"),
            b"{invalid-previous"
        );
        assert_eq!(
            fs::read(&next_path).expect("next remains"),
            b"{invalid-next"
        );
        let notice = notice.expect("fallback notice");
        assert!(notice.contains("本次使用默认设置启动"));
        assert!(notice.contains("settings.json.previous"));
        assert!(notice.contains("settings.json.next"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn loads_legacy_system_ocr_as_the_supported_windows_default() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = SettingsStore::new(directory.path());
        let mut raw = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        raw["screenshotTranslation"]["ocrMethod"] = serde_json::json!("system");
        fs::write(
            store.path(),
            serde_json::to_vec(&raw).expect("encode settings"),
        )
        .expect("write legacy settings");

        let loaded = store.load().expect("load legacy settings");
        assert_eq!(
            loaded.screenshot_translation.ocr_method,
            crate::domain::settings::OcrMethod::Chaoxing
        );
    }
}
