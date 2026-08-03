use crate::application::lifecycle::{register_changed_shortcuts, update_tray};
use crate::application::state::AppState;
use crate::domain::settings::{
    save_transaction, AppSettings, ProviderSettings, SettingsEffects, SettingsExport,
    TranslationMethod,
};
use crate::infrastructure::credentials::CredentialVault;
use crate::infrastructure::provider_http;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveResult {
    settings: AppSettings,
    applied_shortcuts: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct ProviderConnectionResult {
    success: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn settings_load(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.current()
}

#[tauri::command]
pub fn startup_notice_take(state: State<'_, AppState>) -> Option<String> {
    state.take_startup_notice()
}

#[tauri::command]
pub fn settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<SettingsSaveResult, String> {
    let _settings_write = state.lock_settings_write()?;
    let previous = state.current()?;
    let mut settings = settings;
    settings.normalize_ai_options();
    let mut effects = RuntimeSettingsEffects {
        app: &app,
        state: &state,
        synchronize_startup: startup_settings_changed(&previous, &settings),
    };
    save_transaction(&mut effects, &previous, &settings)?;
    Ok(SettingsSaveResult {
        applied_shortcuts: HashMap::from([
            ("translator".into(), settings.shortcuts.translator.clone()),
            ("vision".into(), settings.shortcuts.vision.clone()),
            (
                "screenshotTranslation".into(),
                settings.shortcuts.screenshot_translation.clone(),
            ),
            (
                "promptOptimizer".into(),
                settings.shortcuts.prompt_optimizer.clone(),
            ),
        ]),
        settings,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettingsPatch {
    #[serde(default)]
    method: Option<TranslationMethod>,
    #[serde(default)]
    source_language: Option<String>,
    #[serde(default)]
    target_language: Option<String>,
}

fn apply_translation_settings_patch(
    settings: &mut AppSettings,
    patch: TranslationSettingsPatch,
) -> Result<(), String> {
    if patch
        .source_language
        .as_deref()
        .is_some_and(|source_language| {
            !matches!(source_language, "auto" | "zh-CN" | "en" | "ja" | "ko")
        })
    {
        return Err("Text translation source language is unsupported".into());
    }
    if patch
        .target_language
        .as_deref()
        .is_some_and(|target_language| {
            !matches!(target_language, "auto" | "zh-CN" | "en" | "ja" | "ko")
        })
    {
        return Err("Text translation target language is unsupported".into());
    }
    if let Some(method) = patch.method {
        settings.translation.method = method;
    }
    if let Some(source_language) = patch.source_language {
        settings.translation.source_language = source_language;
    }
    if let Some(target_language) = patch.target_language {
        settings.translation.target_language = target_language;
    }
    settings.normalize_ai_options();
    settings.validate()
}

#[tauri::command]
pub fn translation_settings_update(
    state: State<'_, AppState>,
    patch: TranslationSettingsPatch,
) -> Result<(), String> {
    let _settings_write = state.lock_settings_write()?;
    let mut settings = state.current()?;
    apply_translation_settings_patch(&mut settings, patch)?;
    state.store.save(&settings)?;
    state.replace(&settings)
}

#[tauri::command]
pub async fn settings_export(
    app: AppHandle,
    state: State<'_, AppState>,
    include_secrets: bool,
) -> Result<bool, String> {
    let settings = state.current()?;
    let secrets = if include_secrets {
        let mut values = HashMap::new();
        for provider in &settings.providers {
            let keys = CredentialVault::provider_keys(&provider.id)?;
            if !keys.is_empty() {
                values.insert(provider.id.clone(), keys);
            }
        }
        Some(values)
    } else {
        None
    };
    let export = SettingsExport {
        export_type: "screenpilot-settings-export".into(),
        schema_version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        exported_at: Utc::now().to_rfc3339(),
        includes_secrets: include_secrets,
        settings,
        secrets,
    };
    let file = app
        .dialog()
        .file()
        .add_filter("ScreenPilot settings", &["json"])
        .set_file_name("ScreenPilot-settings.json")
        .blocking_save_file();
    let Some(file) = file else {
        return Ok(false);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&export).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn settings_import(app: AppHandle) -> Result<Option<SettingsExport>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("ScreenPilot settings", &["json"])
        .blocking_pick_file();
    let Some(file) = file else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let raw_export = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| format!("Settings import is invalid: {error}"))?;
    let mut export = serde_json::from_value::<SettingsExport>(raw_export.clone())
        .map_err(|error| format!("Settings import is invalid: {error}"))?;
    if export.export_type != "screenpilot-settings-export" || export.schema_version != 1 {
        return Err("Settings import type or schema is unsupported".into());
    }
    let raw_settings = raw_export.get("settings").cloned().unwrap_or_default();
    export.settings.migrate_missing_ai_toggles(&raw_settings);
    export.settings.validate()?;
    Ok(Some(export))
}

#[tauri::command]
pub async fn directory_pick(app: AppHandle) -> Result<Option<String>, String> {
    let directory = app.dialog().file().blocking_pick_folder();
    directory
        .map(|path| {
            path.into_path()
                .map_err(|error| error.to_string())
                .and_then(|path| {
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| "Selected directory is not valid Unicode".into())
                })
        })
        .transpose()
}

#[tauri::command]
pub fn credentials_set_provider_keys(provider_id: String, keys: Vec<String>) -> Result<(), String> {
    CredentialVault::set_provider_keys(&provider_id, &keys)
}

#[tauri::command]
pub fn credentials_set_provider_keys_batch(
    changes: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    CredentialVault::set_provider_keys_batch(&changes)
}

#[tauri::command]
pub fn credentials_provider_key_count(provider_id: String) -> Result<usize, String> {
    CredentialVault::provider_key_count(&provider_id)
}

#[tauri::command]
pub fn credentials_delete_provider_keys(provider_id: String) -> Result<(), String> {
    CredentialVault::delete_provider_keys(&provider_id)
}

#[tauri::command]
pub async fn providers_fetch_models(
    provider: ProviderSettings,
    keys: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let primary_key = resolve_provider_primary_key(&provider.id, keys.as_deref())?;
    provider_http::fetch_models(&provider, primary_key.as_deref())
        .await
        .map_err(|error| redact_provider_error(error, primary_key.as_deref()))
}

#[tauri::command]
pub async fn providers_test(
    provider: ProviderSettings,
    keys: Option<Vec<String>>,
) -> ProviderConnectionResult {
    let primary_key = match resolve_provider_primary_key(&provider.id, keys.as_deref()) {
        Ok(primary_key) => primary_key,
        Err(error) => {
            return ProviderConnectionResult {
                success: false,
                error: Some(error),
            }
        }
    };
    match provider_http::test_connection(&provider, primary_key.as_deref().unwrap_or("")).await {
        Ok(()) => ProviderConnectionResult {
            success: true,
            error: None,
        },
        Err(error) => ProviderConnectionResult {
            success: false,
            error: Some(redact_provider_error(error, primary_key.as_deref())),
        },
    }
}

fn redact_provider_error(error: String, primary_key: Option<&str>) -> String {
    match primary_key.filter(|key| !key.is_empty()) {
        Some(key) => error.replace(key, "***"),
        None => error,
    }
}

fn first_non_empty_key(keys: &[String]) -> Option<String> {
    keys.iter()
        .map(|key| key.trim())
        .find(|key| !key.is_empty())
        .map(str::to_owned)
}

fn select_primary_provider_key(
    draft_keys: Option<&[String]>,
    persisted_keys: &[String],
) -> Option<String> {
    match draft_keys {
        Some(draft_keys) => first_non_empty_key(draft_keys),
        None => first_non_empty_key(persisted_keys),
    }
}

fn resolve_provider_primary_key(
    provider_id: &str,
    draft_keys: Option<&[String]>,
) -> Result<Option<String>, String> {
    resolve_provider_primary_key_with(draft_keys, || CredentialVault::provider_keys(provider_id))
}

fn resolve_provider_primary_key_with<F>(
    draft_keys: Option<&[String]>,
    load_persisted: F,
) -> Result<Option<String>, String>
where
    F: FnOnce() -> Result<Vec<String>, String>,
{
    if let Some(draft_keys) = draft_keys {
        return Ok(select_primary_provider_key(Some(draft_keys), &[]));
    }
    let persisted_keys = load_persisted()?;
    Ok(select_primary_provider_key(None, &persisted_keys))
}

struct RuntimeSettingsEffects<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    synchronize_startup: bool,
}

impl SettingsEffects for RuntimeSettingsEffects<'_> {
    fn apply_startup(&mut self, settings: &AppSettings) -> Result<(), String> {
        if !self.synchronize_startup {
            return Ok(());
        }
        let regular = self.app.autolaunch();
        if settings.general.launch_at_startup_as_administrator {
            if regular.is_enabled().map_err(|error| error.to_string())? {
                regular.disable().map_err(|error| error.to_string())?;
            }
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            crate::platform::windows::startup::set_enabled(true, &executable)
        } else {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            if crate::platform::windows::startup::is_enabled()? {
                crate::platform::windows::startup::set_enabled(false, &executable)?;
            }
            let enabled = regular.is_enabled().map_err(|error| error.to_string())?;
            match (settings.general.launch_at_startup, enabled) {
                (true, false) => regular.enable().map_err(|error| error.to_string()),
                (false, true) => regular.disable().map_err(|error| error.to_string()),
                _ => Ok(()),
            }
        }
    }

    fn replace_runtime(&mut self, settings: &AppSettings) -> Result<(), String> {
        self.state.replace(settings)
    }

    fn register_shortcuts(
        &mut self,
        previous: &AppSettings,
        next: &AppSettings,
    ) -> Result<(), String> {
        register_changed_shortcuts(self.app, previous, next)
    }

    fn persist(&mut self, settings: &AppSettings) -> Result<(), String> {
        self.state.store.save(settings)
    }

    fn update_tray(&mut self, _settings: &AppSettings) -> Result<(), String> {
        update_tray(self.app)
    }
}

fn startup_settings_changed(previous: &AppSettings, next: &AppSettings) -> bool {
    previous.general.launch_at_startup != next.general.launch_at_startup
        || previous.general.launch_at_startup_as_administrator
            != next.general.launch_at_startup_as_administrator
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_patch_preserves_provider_and_model_selection() {
        let mut settings = AppSettings::default();
        settings.providers.push(ProviderSettings {
            id: "custom".into(),
            name: "Custom".into(),
            base_url: "https://example.com/v1".into(),
            key_count: 1,
            available_models: vec!["model-a".into()],
            enabled_models: vec!["model-a".into()],
        });
        settings.translation.ai_model = Some(crate::domain::settings::ModelSelection {
            provider_id: "custom".into(),
            model: "model-a".into(),
        });
        settings.translation.ai_enabled = true;
        let providers = settings.providers.clone();
        let model = settings.translation.ai_model.clone();
        apply_translation_settings_patch(
            &mut settings,
            TranslationSettingsPatch {
                method: Some(TranslationMethod::Ai),
                source_language: Some("en".into()),
                target_language: Some("ja".into()),
            },
        )
        .expect("valid translation patch");
        assert_eq!(settings.providers, providers);
        assert_eq!(settings.translation.ai_model, model);
        assert_eq!(settings.translation.method, TranslationMethod::Ai);
        assert_eq!(settings.translation.source_language, "en");
        assert_eq!(settings.translation.target_language, "ja");
    }

    #[test]
    fn translation_patch_rejects_unknown_target_language_without_mutating() {
        let mut settings = AppSettings::default();
        let before = settings.clone();
        let error = apply_translation_settings_patch(
            &mut settings,
            TranslationSettingsPatch {
                method: None,
                source_language: None,
                target_language: Some("xx".into()),
            },
        )
        .expect_err("unsupported language should fail");
        assert_eq!(error, "Text translation target language is unsupported");
        assert_eq!(settings, before);
    }

    #[test]
    fn translation_patch_rejects_unknown_source_language_without_mutating() {
        let mut settings = AppSettings::default();
        let before = settings.clone();
        let error = apply_translation_settings_patch(
            &mut settings,
            TranslationSettingsPatch {
                method: None,
                source_language: Some("xx".into()),
                target_language: None,
            },
        )
        .expect_err("unsupported source language should fail");
        assert_eq!(error, "Text translation source language is unsupported");
        assert_eq!(settings, before);
    }

    #[test]
    fn only_synchronizes_startup_after_a_startup_setting_changes() {
        let previous = AppSettings::default();
        let mut shortcut_change = previous.clone();
        shortcut_change.shortcuts.translator = "Control+F2".into();
        assert!(!startup_settings_changed(&previous, &shortcut_change));

        let mut regular_startup_change = previous.clone();
        regular_startup_change.general.launch_at_startup = true;
        assert!(startup_settings_changed(&previous, &regular_startup_change));

        let mut administrator_startup_change = previous.clone();
        administrator_startup_change
            .general
            .launch_at_startup_as_administrator = true;
        assert!(startup_settings_changed(
            &previous,
            &administrator_startup_change
        ));
    }

    #[test]
    fn provider_key_selection_prefers_non_empty_draft_without_reading_persisted_values() {
        let draft = vec!["  draft-primary  ".into(), "draft-backup".into()];
        assert_eq!(
            resolve_provider_primary_key_with(Some(&draft), || {
                Err("vault must not be read".into())
            })
            .expect("draft override should short circuit vault access"),
            Some("draft-primary".into())
        );
    }

    #[test]
    fn provider_key_selection_uses_persisted_primary_only_when_draft_is_untouched() {
        let persisted = vec!["  persisted-primary  ".into(), "persisted-backup".into()];
        assert_eq!(
            resolve_provider_primary_key_with(None, || Ok(persisted))
                .expect("persisted key lookup should succeed"),
            Some("persisted-primary".into())
        );
    }

    #[test]
    fn provider_key_selection_keeps_explicit_empty_draft_empty() {
        let draft = vec!["  ".into()];
        let persisted = vec!["persisted-primary".into()];
        assert_eq!(select_primary_provider_key(Some(&draft), &persisted), None);
    }

    #[test]
    fn provider_errors_redact_the_resolved_primary_key() {
        let error = redact_provider_error(
            "request failed for draft-primary".into(),
            Some("draft-primary"),
        );
        assert_eq!(error, "request failed for ***");
        assert_eq!(
            redact_provider_error("request failed".into(), None),
            "request failed"
        );
    }
}
