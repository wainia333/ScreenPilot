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
    target_language: Option<String>,
}

fn apply_translation_settings_patch(
    settings: &mut AppSettings,
    patch: TranslationSettingsPatch,
) -> Result<(), String> {
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
    if let Some(target_language) = patch.target_language {
        settings.translation.target_language = target_language;
    }
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
    let export = serde_json::from_slice::<SettingsExport>(&bytes)
        .map_err(|error| format!("Settings import is invalid: {error}"))?;
    if export.export_type != "screenpilot-settings-export" || export.schema_version != 1 {
        return Err("Settings import type or schema is unsupported".into());
    }
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
pub fn credentials_provider_key_count(provider_id: String) -> Result<usize, String> {
    CredentialVault::provider_key_count(&provider_id)
}

#[tauri::command]
pub fn credentials_delete_provider_keys(provider_id: String) -> Result<(), String> {
    CredentialVault::delete_provider_keys(&provider_id)
}

#[tauri::command]
pub async fn providers_fetch_models(provider: ProviderSettings) -> Result<Vec<String>, String> {
    let keys = CredentialVault::provider_keys(&provider.id)?;
    provider_http::fetch_models(&provider, keys.first().map(String::as_str)).await
}

#[tauri::command]
pub async fn providers_test(
    provider: ProviderSettings,
    keys: Vec<String>,
) -> ProviderConnectionResult {
    match provider_http::test_connection(&provider, keys.first().map_or("", String::as_str)).await {
        Ok(()) => ProviderConnectionResult {
            success: true,
            error: None,
        },
        Err(error) => ProviderConnectionResult {
            success: false,
            error: Some(error),
        },
    }
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
        let providers = settings.providers.clone();
        let model = settings.translation.ai_model.clone();
        apply_translation_settings_patch(
            &mut settings,
            TranslationSettingsPatch {
                method: Some(TranslationMethod::Ai),
                target_language: Some("ja".into()),
            },
        )
        .expect("valid translation patch");
        assert_eq!(settings.providers, providers);
        assert_eq!(settings.translation.ai_model, model);
        assert_eq!(settings.translation.method, TranslationMethod::Ai);
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
                target_language: Some("xx".into()),
            },
        )
        .expect_err("unsupported language should fail");
        assert_eq!(error, "Text translation target language is unsupported");
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
}
