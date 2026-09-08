use crate::application::state::AppState;
use crate::infrastructure::ai_http::{
    complete_text_cancelled, complete_text_with_effort_cancelled, AiRequestPolicy,
};
use crate::infrastructure::credentials::CredentialVault;
use crate::infrastructure::translation;
use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::time::{sleep, Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRequest {
    text: String,
    method: String,
    #[serde(default = "default_source_language")]
    source_language: String,
    target_language: String,
    generation: u64,
}

#[derive(Serialize)]
pub struct TranslationResult {
    generation: u64,
    text: String,
}

#[derive(Deserialize)]
pub struct PromptOptimizationRequest {
    text: String,
    generation: u64,
}

#[derive(Serialize)]
pub struct PromptOptimizationResult {
    generation: u64,
    text: String,
}

#[tauri::command]
pub async fn translator_translate(
    state: State<'_, AppState>,
    request: TranslationRequest,
) -> Result<TranslationResult, String> {
    let signal = state
        .begin_translator_request(request.generation)
        .ok_or("Request cancelled")?;
    let text = request.text.trim();
    if text.is_empty() {
        return Ok(TranslationResult {
            generation: request.generation,
            text: String::new(),
        });
    }
    validate_translation_source_language(&request.source_language)?;
    validate_translation_target_language(&request.target_language)?;
    let source_language = translation::resolve_source_language(text, &request.source_language);
    let target_language = translation::resolve_target_language_for_source(
        text,
        &request.target_language,
        source_language,
    );
    let target_language_name = translation_target_language_name(target_language)?;
    let mut settings = state.current()?;
    settings.normalize_ai_options();
    let translated = if request.method == "ai" {
        if !settings.translation.ai_enabled {
            return Err("AI translation is disabled in settings".into());
        }
        let selection = settings
            .translation
            .ai_model
            .as_ref()
            .ok_or("Select an AI translation model in settings")?;
        let provider = settings
            .providers
            .iter()
            .find(|provider| provider.id == selection.provider_id)
            .ok_or("The selected translation provider no longer exists")?;
        let keys = CredentialVault::provider_keys(&provider.id)?;
        complete_text_cancelled(
            provider,
            &selection.model,
            &keys,
            &build_translation_prompt(
                &settings.translation.prompt,
                text,
                target_language_name,
                source_language,
            ),
            "",
            AiRequestPolicy::new(settings.retry.enabled, settings.retry.attempts, false),
            Some(signal.clone()),
        )
        .await?
    } else {
        let credentials = adapter_credentials(&request.method)?;
        translation::translate_with_source_cancelled(
            &request.method,
            text,
            source_language,
            target_language,
            &credentials,
            Some(&signal),
        )
        .await?
    };
    if !state.translator_request_current(request.generation) {
        return Err("Request cancelled".into());
    }
    Ok(TranslationResult {
        generation: request.generation,
        text: translated,
    })
}

#[tauri::command]
pub fn translator_cancel(state: State<'_, AppState>, generation: u64) -> bool {
    state.cancel_translator_request(generation)
}

fn translation_target_language_name(target_language: &str) -> Result<&'static str, String> {
    match target_language {
        "zh-CN" => Ok("Simplified Chinese"),
        "en" => Ok("English"),
        "ja" => Ok("Japanese"),
        "ko" => Ok("Korean"),
        _ => Err("Unsupported text translation target language".into()),
    }
}

fn validate_translation_source_language(source_language: &str) -> Result<(), String> {
    if matches!(source_language, "auto" | "zh-CN" | "en" | "ja" | "ko") {
        Ok(())
    } else {
        Err("Unsupported text translation source language".into())
    }
}

fn validate_translation_target_language(target_language: &str) -> Result<(), String> {
    if matches!(target_language, "auto" | "zh-CN" | "en" | "ja" | "ko") {
        Ok(())
    } else {
        Err("Unsupported text translation target language".into())
    }
}

fn build_template_prompt(template: &str, text: &str, language: &str) -> String {
    let trimmed = template.trim();
    let mut prompt = trimmed.replace("{lang}", language).replace("{text}", text);
    if !trimmed.contains("{text}") {
        prompt.push_str("\n\n");
        prompt.push_str(text);
    }
    prompt
}

fn build_translation_prompt(template: &str, text: &str, language: &str, source: &str) -> String {
    let prompt = build_template_prompt(template, text, language)
        .replace("{sourceLang}", translation_source_language_name(source))
        .replace("{source}", translation_source_language_name(source));
    if source == "auto" {
        prompt
    } else {
        format!(
            "Translate from {}.\n\n{}",
            translation_source_language_name(source),
            prompt
        )
    }
}

fn translation_source_language_name(source_language: &str) -> &'static str {
    match source_language {
        "zh-CN" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        _ => "the detected source language",
    }
}

fn default_source_language() -> String {
    "auto".into()
}

fn optimizer_response_language_name(language: &str, text: &str) -> &'static str {
    match language {
        "en" => "English",
        "zh-CN" => "Simplified Chinese",
        _ if text
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character)) =>
        {
            "Simplified Chinese"
        }
        _ => "English",
    }
}

fn adapter_credentials(method: &str) -> Result<Vec<String>, String> {
    let id = match method {
        "baidu" => Some("adapter-baidu-translation"),
        "tencent" => Some("adapter-tencent-translation"),
        "caiyun2" => Some("adapter-caiyun-translation"),
        _ => None,
    };
    id.map(CredentialVault::provider_keys)
        .transpose()
        .map(Option::unwrap_or_default)
}

trait PasteKeyboard {
    fn press_control(&mut self) -> Result<(), String>;
    fn click_paste(&mut self) -> Result<(), String>;
    fn release_control(&mut self) -> Result<(), String>;
}

impl PasteKeyboard for Enigo {
    fn press_control(&mut self) -> Result<(), String> {
        self.key(Key::Control, Direction::Press)
            .map_err(|error| error.to_string())
    }

    fn click_paste(&mut self) -> Result<(), String> {
        self.key(Key::Unicode('v'), Direction::Click)
            .map_err(|error| error.to_string())
    }

    fn release_control(&mut self) -> Result<(), String> {
        self.key(Key::Control, Direction::Release)
            .map_err(|error| error.to_string())
    }
}

fn inject_paste<K: PasteKeyboard>(keyboard: &mut K) -> Result<(), String> {
    keyboard.press_control()?;
    let paste = keyboard.click_paste();
    let release = keyboard.release_control();
    match (paste, release) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(paste_error), Ok(())) => Err(paste_error),
        (Ok(()), Err(release_error)) => Err(release_error),
        (Err(paste_error), Err(release_error)) => Err(format!(
            "Paste key injection failed: {paste_error}; Ctrl release failed: {release_error}"
        )),
    }
}

#[tauri::command]
pub async fn optimizer_run(
    state: State<'_, AppState>,
    request: PromptOptimizationRequest,
) -> Result<PromptOptimizationResult, String> {
    let signal = state
        .begin_optimizer_request(request.generation)
        .ok_or("Request cancelled")?;
    let settings = state.current()?;
    if !settings.prompt_optimizer.enabled {
        return Err("Prompt optimizer is disabled in settings".into());
    }
    let selection = settings
        .prompt_optimizer
        .model
        .as_ref()
        .ok_or("Select a prompt optimizer model in settings")?;
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == selection.provider_id)
        .ok_or("The selected optimizer provider no longer exists")?;
    let keys = CredentialVault::provider_keys(&provider.id)?;
    let language_name = optimizer_response_language_name(
        &settings.prompt_optimizer.response_language,
        &request.text,
    );
    let text = complete_text_with_effort_cancelled(
        provider,
        &selection.model,
        &keys,
        &settings.prompt_optimizer.system_prompt,
        &build_template_prompt(
            &settings.prompt_optimizer.optimize_prompt,
            &request.text,
            language_name,
        ),
        AiRequestPolicy::new(settings.retry.enabled, settings.retry.attempts, false),
        settings.prompt_optimizer.thinking_effort,
        Some(signal),
    )
    .await?;
    if !state.optimizer_request_current(request.generation) {
        return Err("Request cancelled".into());
    }
    Ok(PromptOptimizationResult {
        generation: request.generation,
        text,
    })
}

#[tauri::command]
pub fn optimizer_cancel(state: State<'_, AppState>, generation: u64) -> bool {
    state.cancel_optimizer_request(generation)
}

#[tauri::command]
pub async fn text_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    auto_paste: bool,
) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("translator") {
        state.begin_surface_action();
        state.cancel_active_translator_request();
        window.hide().map_err(|error| error.to_string())?;
    } else if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|error| error.to_string())?;
    }
    if auto_paste {
        sleep(Duration::from_millis(600)).await;
        let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
        inject_paste(&mut enigo)?;
    }
    Ok(())
}

#[tauri::command]
pub fn translator_take_selection(state: State<'_, AppState>) -> String {
    state.take_translator_selection()
}

#[tauri::command]
pub async fn window_hide(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    if matches!(window.label(), "vision" | "ocr") {
        return super::vision::vision_close(window.app_handle().clone(), window, state).await;
    }
    if window.label() == "translator" {
        return crate::application::lifecycle::close_translator_window(window)
            .await
            .map_err(|error| error.to_string())?;
    }
    if window.label() == "main" {
        return crate::application::lifecycle::close_main_window(window)
            .await
            .map_err(|error| error.to_string())?;
    }
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn vision_take_selection(state: State<'_, AppState>) -> String {
    state.take_vision_selection()
}

#[cfg(test)]
mod tests {
    use super::{
        build_template_prompt, build_translation_prompt, inject_paste,
        optimizer_response_language_name, translation_target_language_name, PasteKeyboard,
    };

    #[derive(Default)]
    struct FaultingKeyboard {
        actions: Vec<&'static str>,
        fail_paste: bool,
        fail_release: bool,
    }

    impl PasteKeyboard for FaultingKeyboard {
        fn press_control(&mut self) -> Result<(), String> {
            self.actions.push("press-control");
            Ok(())
        }

        fn click_paste(&mut self) -> Result<(), String> {
            self.actions.push("click-paste");
            if self.fail_paste {
                Err("paste unavailable".into())
            } else {
                Ok(())
            }
        }

        fn release_control(&mut self) -> Result<(), String> {
            self.actions.push("release-control");
            if self.fail_release {
                Err("release unavailable".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn matches_the_screenshot_translation_target_language_contract() {
        for language in ["zh-CN", "en", "ja", "ko"] {
            assert!(!translation_target_language_name(language)
                .expect("supported language")
                .is_empty());
        }
        assert!(translation_target_language_name("unsupported").is_err());
    }

    #[test]
    fn expands_translation_template_and_appends_text_for_custom_prompt() {
        assert_eq!(
            build_template_prompt("Translate to {lang}: {text}", "hello", "Japanese"),
            "Translate to Japanese: hello"
        );
        assert_eq!(
            build_template_prompt("Translate faithfully", "hello", "Japanese"),
            "Translate faithfully\n\nhello"
        );
    }

    #[test]
    fn includes_explicit_source_language_in_ai_prompt() {
        assert!(build_translation_prompt(
            "Translate to {lang}: {text}",
            "hello",
            "Simplified Chinese",
            "en"
        )
        .starts_with("Translate from English."));
        assert_eq!(
            build_translation_prompt(
                "Translate to {lang}: {text}",
                "hello",
                "Simplified Chinese",
                "auto"
            ),
            "Translate to Simplified Chinese: hello"
        );
    }

    #[test]
    fn maps_optimizer_response_language_to_template_name() {
        assert_eq!(
            optimizer_response_language_name("auto", "请优化这段提示词"),
            "Simplified Chinese"
        );
        assert_eq!(
            optimizer_response_language_name("auto", "Optimize this prompt"),
            "English"
        );
        assert_eq!(
            optimizer_response_language_name("zh-CN", "Optimize this prompt"),
            "Simplified Chinese"
        );
        assert_eq!(
            optimizer_response_language_name("en", "请优化这段提示词"),
            "English"
        );
    }

    #[test]
    fn releases_control_when_paste_key_injection_fails() {
        let mut keyboard = FaultingKeyboard {
            fail_paste: true,
            ..FaultingKeyboard::default()
        };

        assert_eq!(inject_paste(&mut keyboard), Err("paste unavailable".into()));
        assert_eq!(
            keyboard.actions,
            ["press-control", "click-paste", "release-control"]
        );
    }

    #[test]
    fn reports_both_paste_and_release_failures_after_attempting_release() {
        let mut keyboard = FaultingKeyboard {
            fail_paste: true,
            fail_release: true,
            ..FaultingKeyboard::default()
        };

        assert_eq!(
            inject_paste(&mut keyboard),
            Err(
                "Paste key injection failed: paste unavailable; Ctrl release failed: release unavailable"
                    .into()
            )
        );
        assert_eq!(
            keyboard.actions,
            ["press-control", "click-paste", "release-control"]
        );
    }
}
