use crate::application::lifecycle::{
    acknowledge_main_navigation, pending_main_navigation, register_changed_shortcuts, update_tray,
};
use crate::application::state::AppState;
use crate::domain::settings::{
    save_transaction, AppSettings, ProviderSettings, SettingsEffects, SettingsExport,
    SettingsSecrets, TranslationMethod, SETTINGS_SECRETS_SCHEMA_VERSION,
};
use crate::infrastructure::credentials::{
    validate_adapter_key_batch_shape, validate_imported_provider_deletions,
    validate_imported_provider_key_batch_shape, validate_provider_key_batch_shape, CredentialVault,
};
use crate::infrastructure::provider_http;
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveResult {
    settings: AppSettings,
    applied_shortcuts: HashMap<String, String>,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    settings: AppSettings,
    revision: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChangedEvent {
    settings: AppSettings,
    revision: u64,
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
pub fn settings_snapshot_load(state: State<'_, AppState>) -> Result<SettingsSnapshot, String> {
    let _settings_write = state.lock_settings_write()?;
    let (settings, revision) = state.settings_snapshot()?;
    Ok(SettingsSnapshot { settings, revision })
}

#[tauri::command]
pub fn startup_notice_take(state: State<'_, AppState>) -> Option<String> {
    // Compatibility alias: startup notices are intentionally non-destructive
    // until the visible surface explicitly acknowledges them.
    state.startup_notice()
}

#[tauri::command]
pub fn startup_notice_peek(state: State<'_, AppState>) -> Option<String> {
    state.startup_notice()
}

#[tauri::command]
pub fn startup_notice_acknowledge(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let main_visible = app
        .get_webview_window("main")
        .map(|window| window.is_visible().map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or(false);
    if !main_visible {
        return Ok(false);
    }
    state.acknowledge_startup_notice();
    Ok(true)
}

#[tauri::command]
pub fn main_navigation_acknowledge(
    app: AppHandle,
    request_id: u64,
    accepted: bool,
) -> Result<(), String> {
    acknowledge_main_navigation(&app, request_id, accepted)
}

#[tauri::command]
pub fn main_navigation_pending(
    state: State<'_, AppState>,
) -> Result<Option<crate::application::lifecycle::MainNavigationRequest>, String> {
    pending_main_navigation(&state)
}

#[tauri::command]
pub fn window_route_current(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<&'static str, String> {
    match window.label() {
        "main" => state.main_route().map(|route| route.name()),
        "translator" => Ok("translator"),
        "vision" | "ocr" => Ok("vision"),
        label => Err(format!("Unknown ScreenPilot window: {label}")),
    }
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
    let revision = state.advance_settings_revision(&settings)?;
    emit_settings_changed(&app, &settings, revision);
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
        revision,
    })
}

#[tauri::command]
pub fn settings_save_patch(
    app: AppHandle,
    state: State<'_, AppState>,
    base_revision: u64,
    patch: Value,
) -> Result<SettingsSaveResult, String> {
    let _settings_write = state.lock_settings_write()?;
    let previous = state.current()?;
    let baseline = state.settings_at_revision(base_revision).ok_or_else(|| {
        "SETTINGS_CONFLICT: the settings baseline is no longer available".to_string()
    })?;
    let previous_value = serde_json::to_value(&previous).map_err(|error| error.to_string())?;
    let baseline_value = serde_json::to_value(&baseline).map_err(|error| error.to_string())?;
    validate_settings_patch_shape(&previous_value, &patch, "settings")?;
    let next_value = merge_settings_patch(previous_value.clone(), &patch)?;
    let mut next = serde_json::from_value::<AppSettings>(next_value)
        .map_err(|error| format!("Invalid settings patch: {error}"))?;
    next.normalize_ai_options();
    let next_value = serde_json::to_value(&next).map_err(|error| error.to_string())?;
    let conflicts =
        settings_conflict_paths(&baseline_value, &previous_value, &next_value, "settings");
    if !conflicts.is_empty() {
        return Err(format!("SETTINGS_CONFLICT: {}", conflicts.join(", ")));
    }
    if next == previous {
        let revision = state.settings_revision();
        return Ok(settings_save_result(next, revision));
    }
    let mut effects = RuntimeSettingsEffects {
        app: &app,
        state: &state,
        synchronize_startup: startup_settings_changed(&previous, &next),
    };
    save_transaction(&mut effects, &previous, &next)?;
    let revision = state.advance_settings_revision(&next)?;
    emit_settings_changed(&app, &next, revision);
    Ok(settings_save_result(next, revision))
}

fn settings_save_result(settings: AppSettings, revision: u64) -> SettingsSaveResult {
    SettingsSaveResult {
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
        revision,
    }
}

fn emit_settings_changed(app: &AppHandle, settings: &AppSettings, revision: u64) {
    let _ = app.emit(
        "screenpilot:settings-changed",
        SettingsChangedEvent {
            settings: settings.clone(),
            revision,
        },
    );
}

fn validate_settings_patch_shape(current: &Value, patch: &Value, path: &str) -> Result<(), String> {
    let Value::Object(patch_object) = patch else {
        return Err("Invalid settings patch: root must be an object".into());
    };
    let Value::Object(current_object) = current else {
        return Err(format!("Invalid settings patch at {path}"));
    };
    for (key, value) in patch_object {
        let current_value = current_object
            .get(key)
            .ok_or_else(|| format!("Invalid settings patch field: {path}.{key}"))?;
        if value.is_object() && current_value.is_object() {
            validate_settings_patch_shape(current_value, value, &format!("{path}.{key}"))?;
        }
    }
    Ok(())
}

fn merge_settings_patch(current: Value, patch: &Value) -> Result<Value, String> {
    let Value::Object(mut current_object) = current else {
        return Err("Invalid settings patch: current settings are not an object".into());
    };
    let Value::Object(patch_object) = patch else {
        return Err("Invalid settings patch: root must be an object".into());
    };
    for (key, value) in patch_object {
        let merged = match current_object.remove(key) {
            Some(current_value) if current_value.is_object() && value.is_object() => {
                merge_settings_patch(current_value, value)?
            }
            _ => value.clone(),
        };
        current_object.insert(key.clone(), merged);
    }
    Ok(Value::Object(current_object))
}

fn settings_conflict_paths(
    baseline: &Value,
    current: &Value,
    next: &Value,
    path: &str,
) -> Vec<String> {
    if let (Value::Object(baseline), Value::Object(current), Value::Object(next)) =
        (baseline, current, next)
    {
        let keys = baseline
            .keys()
            .chain(current.keys())
            .chain(next.keys())
            .collect::<std::collections::BTreeSet<_>>();
        return keys
            .into_iter()
            .flat_map(|key| {
                let baseline_value = baseline.get(key).unwrap_or(&Value::Null);
                let current_value = current.get(key).unwrap_or(&Value::Null);
                let next_value = next.get(key).unwrap_or(&Value::Null);
                settings_conflict_paths(
                    baseline_value,
                    current_value,
                    next_value,
                    &format!("{path}.{key}"),
                )
            })
            .collect();
    }
    if current != next && baseline != current {
        vec![path.to_string()]
    } else {
        Vec::new()
    }
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
    app: AppHandle,
    state: State<'_, AppState>,
    patch: TranslationSettingsPatch,
) -> Result<(), String> {
    let _settings_write = state.lock_settings_write()?;
    let mut settings = state.current()?;
    apply_translation_settings_patch(&mut settings, patch)?;
    state.store.save(&settings)?;
    state.replace(&settings)?;
    let revision = state.advance_settings_revision(&settings)?;
    emit_settings_changed(&app, &settings, revision);
    Ok(())
}

#[tauri::command]
pub async fn settings_export(
    app: AppHandle,
    state: State<'_, AppState>,
    include_secrets: bool,
) -> Result<bool, String> {
    let settings = state.current()?;
    let secrets = if include_secrets {
        let mut providers = HashMap::new();
        for provider in &settings.providers {
            let keys = CredentialVault::provider_keys(&provider.id)?;
            if !keys.is_empty() {
                providers.insert(provider.id.clone(), keys);
            }
        }
        validate_provider_key_batch_shape(&providers)?;
        let mut secrets =
            SettingsSecrets::new(providers, CredentialVault::adapter_keys_for_export()?);
        secrets.integrations = CredentialVault::integration_keys_for_export()?;
        Some(secrets)
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
    export.settings.migrate_prompt_defaults();
    export.settings.normalize_ai_options();
    export.settings.validate()?;
    validate_imported_secrets(&mut export)?;
    Ok(Some(export))
}

fn validate_imported_secrets(export: &mut SettingsExport) -> Result<(), String> {
    if !export.includes_secrets {
        export.secrets = None;
        return Ok(());
    }
    let Some(secrets) = export.secrets.as_ref() else {
        return Ok(());
    };
    if secrets.schema_version != SETTINGS_SECRETS_SCHEMA_VERSION {
        return Err("Settings secrets schema is unsupported".into());
    }
    validate_imported_provider_key_batch_shape(&secrets.providers)?;
    let provider_ids = export
        .settings
        .providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if secrets
        .providers
        .keys()
        .any(|provider_id| !provider_ids.contains(provider_id.as_str()))
    {
        return Err("Settings secrets contain a provider that is not present in settings".into());
    }
    crate::infrastructure::credentials::validate_integration_secrets(&secrets.integrations)?;
    validate_adapter_key_batch_shape(&secrets.adapters)
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
pub fn credentials_set_adapter_keys_batch(
    changes: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    CredentialVault::set_adapter_keys_batch(&changes)
}

#[tauri::command]
pub fn credentials_set_imported_secrets(
    app: AppHandle,
    state: State<'_, AppState>,
    secrets: SettingsSecrets,
    provider_deletion_ids: Vec<String>,
) -> Result<(), String> {
    let settings = state.current()?;
    validate_imported_secret_save(&settings, &secrets, &provider_deletion_ids)?;
    if !secrets.integrations.is_empty() {
        state.cancel_reference_vision_stream();
    }
    CredentialVault::import_all_secrets(
        &secrets.providers,
        &secrets.adapters,
        &secrets.integrations,
        &provider_deletion_ids,
    )?;
    if !secrets.integrations.is_empty() {
        let _ = app.emit("screenpilot:karakeep-credential-changed", true);
    }
    Ok(())
}

fn validate_imported_secret_save(
    settings: &AppSettings,
    secrets: &SettingsSecrets,
    provider_deletion_ids: &[String],
) -> Result<(), String> {
    if secrets.schema_version != SETTINGS_SECRETS_SCHEMA_VERSION {
        return Err("Settings secrets schema is unsupported".into());
    }
    validate_imported_provider_key_batch_shape(&secrets.providers)?;
    validate_imported_provider_deletions(&secrets.providers, provider_deletion_ids)?;
    validate_adapter_key_batch_shape(&secrets.adapters)?;
    crate::infrastructure::credentials::validate_integration_secrets(&secrets.integrations)?;
    let provider_ids = settings
        .providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if secrets
        .providers
        .keys()
        .any(|provider_id| !provider_ids.contains(provider_id.as_str()))
    {
        return Err("Settings secrets contain a provider that is not present in settings".into());
    }
    if provider_deletion_ids
        .iter()
        .any(|provider_id| provider_ids.contains(provider_id.as_str()))
    {
        return Err(
            "Provider credentials cannot be deleted while the provider is in settings".into(),
        );
    }
    Ok(())
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
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;

        // `launch_at_startup` owns whether any startup entry exists. The
        // administrator flag only selects the implementation used while that
        // entry is enabled; it must never create an entry by itself.
        match startup_mode(settings) {
            StartupMode::Disabled => {
                if regular.is_enabled().map_err(|error| error.to_string())? {
                    regular.disable().map_err(|error| error.to_string())?;
                }
                if crate::platform::windows::startup::is_enabled()? {
                    crate::platform::windows::startup::set_enabled(false, &executable)?;
                }
                Ok(())
            }
            StartupMode::Administrator => {
                if regular.is_enabled().map_err(|error| error.to_string())? {
                    regular.disable().map_err(|error| error.to_string())?;
                }
                crate::platform::windows::startup::set_enabled(true, &executable)
            }
            StartupMode::Regular => {
                // A regular autostart and the elevated task are mutually
                // exclusive. Remove a task left by an earlier administrator
                // mode before enabling the regular autostart entry.
                if crate::platform::windows::startup::is_enabled()? {
                    crate::platform::windows::startup::set_enabled(false, &executable)?;
                }
                if !regular.is_enabled().map_err(|error| error.to_string())? {
                    regular.enable().map_err(|error| error.to_string())?;
                }
                Ok(())
            }
        }
    }

    fn replace_runtime(&mut self, settings: &AppSettings) -> Result<(), String> {
        if self.state.current()?.karakeep != settings.karakeep {
            self.state.cancel_reference_vision_stream();
        }
        self.state.replace(settings)?;
        #[cfg(target_os = "windows")]
        crate::platform::windows::altsnap::update(&settings.alt_snap)?;
        Ok(())
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

    fn update_tray(&mut self, settings: &AppSettings) -> Result<(), String> {
        update_tray(self.app, settings)
    }
}

fn startup_settings_changed(previous: &AppSettings, next: &AppSettings) -> bool {
    previous.general.launch_at_startup != next.general.launch_at_startup
        || previous.general.launch_at_startup_as_administrator
            != next.general.launch_at_startup_as_administrator
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupMode {
    Disabled,
    Regular,
    Administrator,
}

fn startup_mode(settings: &AppSettings) -> StartupMode {
    if !settings.general.launch_at_startup {
        StartupMode::Disabled
    } else if settings.general.launch_at_startup_as_administrator {
        StartupMode::Administrator
    } else {
        StartupMode::Regular
    }
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
            protocol: crate::domain::providers::ApiProtocol::Responses,
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
    fn settings_patch_merges_disjoint_changes_from_the_current_revision() {
        let baseline = AppSettings::default();
        let mut current = baseline.clone();
        current.translation.target_language = "ja".into();
        let patch = serde_json::json!({ "theme": "dark" });
        let baseline_value = serde_json::to_value(&baseline).expect("baseline JSON");
        let current_value = serde_json::to_value(&current).expect("current JSON");
        validate_settings_patch_shape(&current_value, &patch, "settings")
            .expect("valid settings patch");
        let next_value =
            merge_settings_patch(current_value.clone(), &patch).expect("merge disjoint patch");
        let conflicts =
            settings_conflict_paths(&baseline_value, &current_value, &next_value, "settings");
        assert!(conflicts.is_empty());
        let next = serde_json::from_value::<AppSettings>(next_value).expect("merged settings");
        assert_eq!(next.theme, crate::domain::settings::ThemeMode::Dark);
        assert_eq!(next.translation.target_language, "ja");
    }

    #[test]
    fn settings_patch_reports_same_field_conflicts_without_silent_overwrite() {
        let baseline = AppSettings::default();
        let mut current = baseline.clone();
        current.translation.target_language = "ja".into();
        let patch = serde_json::json!({ "translation": { "targetLanguage": "en" } });
        let baseline_value = serde_json::to_value(&baseline).expect("baseline JSON");
        let current_value = serde_json::to_value(&current).expect("current JSON");
        let next_value =
            merge_settings_patch(current_value.clone(), &patch).expect("merge conflicting patch");
        let conflicts =
            settings_conflict_paths(&baseline_value, &current_value, &next_value, "settings");
        assert_eq!(conflicts, vec!["settings.translation.targetLanguage"]);
        assert_eq!(next_value["translation"]["targetLanguage"], "en");
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
    fn startup_mode_is_owned_by_launch_at_startup() {
        let mut settings = AppSettings::default();
        assert_eq!(startup_mode(&settings), StartupMode::Disabled);

        settings.general.launch_at_startup_as_administrator = true;
        assert_eq!(
            startup_mode(&settings),
            StartupMode::Disabled,
            "administrator identity must not enable startup by itself"
        );

        settings.general.launch_at_startup = true;
        assert_eq!(startup_mode(&settings), StartupMode::Administrator);

        settings.general.launch_at_startup_as_administrator = false;
        assert_eq!(startup_mode(&settings), StartupMode::Regular);
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

    fn export_with_secrets(secrets: SettingsSecrets) -> SettingsExport {
        let mut settings = AppSettings::default();
        settings.providers.push(ProviderSettings {
            id: "provider-a".into(),
            name: "Provider A".into(),
            base_url: "https://example.com/v1".into(),
            protocol: crate::domain::providers::ApiProtocol::Responses,
            key_count: 1,
            available_models: Vec::new(),
            enabled_models: Vec::new(),
        });
        SettingsExport {
            export_type: "screenpilot-settings-export".into(),
            schema_version: 1,
            app_version: "0.1.0".into(),
            exported_at: "2026-08-10T00:00:00Z".into(),
            includes_secrets: true,
            settings,
            secrets: Some(secrets),
        }
    }

    #[test]
    fn imported_secrets_reject_unknown_adapter_ids_and_provider_injection() {
        let mut unknown_adapter = export_with_secrets(SettingsSecrets::new(
            HashMap::new(),
            HashMap::from([("adapter-unknown".into(), vec!["secret".into()])]),
        ));
        assert_eq!(
            validate_imported_secrets(&mut unknown_adapter),
            Err("Adapter credential id is unsupported".into())
        );

        let mut unknown_provider = export_with_secrets(SettingsSecrets::new(
            HashMap::from([("provider-b".into(), vec!["secret".into()])]),
            HashMap::new(),
        ));
        assert_eq!(
            validate_imported_secrets(&mut unknown_provider),
            Err("Settings secrets contain a provider that is not present in settings".into())
        );
    }

    #[test]
    fn imported_secrets_validate_adapter_cardinality_and_schema() {
        let mut incomplete_adapter = export_with_secrets(SettingsSecrets::new(
            HashMap::new(),
            HashMap::from([("adapter-baidu-ocr".into(), vec!["api-key".into()])]),
        ));
        assert_eq!(
            validate_imported_secrets(&mut incomplete_adapter),
            Err("Adapter adapter-baidu-ocr requires exactly 2 non-empty credential fields".into())
        );

        let mut unsupported_schema = export_with_secrets(SettingsSecrets {
            schema_version: SETTINGS_SECRETS_SCHEMA_VERSION + 1,
            providers: HashMap::new(),
            adapters: HashMap::new(),
            integrations: HashMap::new(),
        });
        assert_eq!(
            validate_imported_secrets(&mut unsupported_schema),
            Err("Settings secrets schema is unsupported".into())
        );
    }

    #[test]
    fn imported_secret_save_only_deletes_providers_absent_from_current_settings() {
        let secrets = SettingsSecrets::new(HashMap::new(), HashMap::new());
        let mut settings = AppSettings::default();
        settings.providers.push(ProviderSettings {
            id: "retained-provider".into(),
            name: "Retained Provider".into(),
            base_url: "https://example.com/v1".into(),
            protocol: crate::domain::providers::ApiProtocol::Responses,
            key_count: 1,
            available_models: Vec::new(),
            enabled_models: Vec::new(),
        });

        assert_eq!(
            validate_imported_secret_save(
                &settings,
                &secrets,
                &[String::from("retained-provider")]
            ),
            Err("Provider credentials cannot be deleted while the provider is in settings".into())
        );
        validate_imported_secret_save(&settings, &secrets, &[String::from("removed-provider")])
            .expect("a provider absent from current settings may be deleted");
    }

    #[test]
    fn import_without_the_secrets_flag_discards_embedded_secret_material() {
        let mut export = export_with_secrets(SettingsSecrets::new(
            HashMap::from([("provider-a".into(), vec!["secret".into()])]),
            HashMap::new(),
        ));
        export.includes_secrets = false;

        validate_imported_secrets(&mut export).expect("ignore unadvertised secrets");
        assert!(export.secrets.is_none());
    }
}
