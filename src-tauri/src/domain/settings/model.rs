use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use url::Url;

pub const SETTINGS_SCHEMA_VERSION: u8 = 1;
pub const SETTINGS_SECRETS_SCHEMA_VERSION: u8 = 1;

const TRANSLATION_PROMPT: &str = "Translate the following text to {lang}. Output only the translation.\n\nRules:\n- Preserve existing LaTeX formulas exactly (keep $...$ and $$...$$).\n- If formula-like plain text appears, normalize it to proper LaTeX when needed.\n- Keep the original line breaks and list structure when possible.\n- Do not add explanations.\n\n{text}";
const OCR_PROMPT: &str = "Read all text in this screenshot and output only the recognized content as copy-ready Markdown.\n\nRules:\n- Do not translate, summarize, explain, or add content that is not visible.\n- Reconstruct natural paragraphs: merge visual line wraps inside the same paragraph.\n- Separate real paragraphs with one blank line.\n- Preserve document structure as Markdown when visible: headings, ordered lists, unordered lists, nested lists, block quotes, tables, code blocks, inline code, links, emphasis, bold, italic, strikethrough, and UI labels.\n- Preserve intentional line breaks for lists, tables, code, mathematical formulas, captions, and UI labels.\n- Output mathematical formulas in LaTeX: use $...$ for inline formulas and $$...$$ for standalone/display formulas.\n- Normalize fractions, superscripts, subscripts, roots, integrals, sums, matrices, Greek letters, and other mathematical symbols to proper LaTeX when they appear in formulas.\n- Preserve non-formula punctuation and symbols exactly.\n- Do not invent Markdown styling when the visual evidence is unclear.\n- Do not wrap the whole result in Markdown code fences; use code fences only for visible code blocks.\n- If no text is visible, output an empty string.";
const SCREENSHOT_TRANSLATION_PROMPT: &str = "Translate the OCR text below to {lang}. Output only the translation.\n\nRules:\n- Preserve existing LaTeX formulas exactly (keep $...$ and $$...$$).\n- If formula-like plain text appears, normalize it to proper LaTeX when needed.\n- Keep paragraph and line-break structure from OCR text when possible.\n- Correct only obvious OCR character mistakes; do not invent missing content.\n- Do not add explanations.\n\n{text}";
const VISION_SYSTEM_PROMPT: &str = "你是一位智能助手，能够看到用户分享的截图。请将其作为视觉上下文来理解和回答，可以涉及信息提取、概念解释、操作协助或任何相关话题。保持回答简洁直接，自然流畅，不用小标题和编号。数学公式用 LaTeX（$...$ 或 $$...$$）。思考保持简洁，避免反复重述。";
const VISION_QUESTION_PROMPT: &str = "用户分享了这张截图，请结合其中的视觉信息来理解和回答：";
const OPTIMIZER_SYSTEM_PROMPT: &str = "你是一个严谨、务实的提示词优化专家。你的目标不是把提示词写得更长，而是让模型更容易稳定地产出符合用户意图的结果。保留用户原始意图、关键约束、语气和必要变量；删除含糊、重复、相互冲突或不可执行的表达；补足角色、任务、上下文、输出格式、质量标准和边界条件。不要编造业务事实。";
const OPTIMIZER_PROMPT: &str = "请优化下面的原始提示词，并使用 {lang} 输出。\n\n优化原则：\n- 先判断任务类型和目标用户，不盲目套模板。\n- 保留原始意图、硬性约束、变量占位符、输入输出字段和语气。\n- 将含糊要求改写为可执行的步骤、判断标准和输出格式。\n- 补足必要上下文、角色边界、禁止事项、异常处理和质量检查。\n- 如果原提示词已经足够清晰，只做轻量整理。\n- 不要添加与原任务无关的能力、工具、背景或事实。\n\n输出格式：\n## 优化后的提示词\n给出可直接复制使用的完整提示词。\n\n## 调整要点\n用 3-6 条短要点说明主要改动。\n\n原始提示词：\n{text}";
const LEGACY_TRANSLATION_PROMPT: &str = "Translate the input into the requested language. Return only the translation. Preserve paragraphs, lists, code, LaTeX, variables, and meaningful formatting.";
const LEGACY_OCR_PROMPT: &str = "Recognize only visible content in the image. Do not translate, summarize, infer, or complete missing text. Return copyable Markdown and preserve code, tables, lists, and mathematical expressions.";
const LEGACY_SCREENSHOT_TRANSLATION_PROMPT: &str = "Translate the recognized text faithfully. Preserve structure and formatting, correct only obvious recognition errors, and never invent missing content.";
const LEGACY_VISION_SYSTEM_PROMPT: &str = "Analyze the supplied image and conversation precisely. State uncertainty when visual evidence is insufficient. Preserve code, tables, lists, and mathematical notation when relevant.";
const LEGACY_VISION_QUESTION_PROMPT: &str =
    "Answer the user question using the visible image and conversation context.";
const LEGACY_OPTIMIZER_SYSTEM_PROMPT: &str =
    "Improve the prompt without changing its intent, hard constraints, variables, tone, or required output format.";
const LEGACY_OPTIMIZER_PROMPT: &str =
    "Rewrite the following prompt so it is clearer and more actionable. Do not add needless length or requirements.";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u8,
    pub theme: ThemeMode,
    pub language: InterfaceLanguage,
    pub retry: RetrySettings,
    pub general: GeneralSettings,
    pub shortcuts: ShortcutSettings,
    pub translation: TranslationSettings,
    pub screenshot_translation: ScreenshotTranslationSettings,
    pub vision: VisionSettings,
    pub prompt_optimizer: PromptOptimizerSettings,
    pub providers: Vec<ProviderSettings>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceLanguage {
    Zh,
    En,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageOrder {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrMethod {
    Ai,
    Baidu,
    Chaoxing,
    System,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranslationMethod {
    Ai,
    Baidu,
    Google,
    Tencent,
    Bing,
    Bing2,
    Yandex,
    Caiyun2,
    Microsoft,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider_id: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub key_count: u8,
    pub available_models: Vec<String>,
    pub enabled_models: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub translator: String,
    pub vision: String,
    pub screenshot_translation: String,
    pub prompt_optimizer: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub auto_paste: bool,
    pub launch_at_startup: bool,
    pub launch_at_startup_as_administrator: bool,
    pub image_archive_enabled: bool,
    pub image_archive_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySettings {
    pub enabled: bool,
    pub attempts: u8,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    #[serde(default = "default_source_language")]
    pub source_language: String,
    pub target_language: String,
    pub method: TranslationMethod,
    #[serde(default)]
    pub ai_enabled: bool,
    pub ai_model: Option<ModelSelection>,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotTranslationSettings {
    pub enabled: bool,
    #[serde(default = "default_source_language")]
    pub source_language: String,
    #[serde(default = "default_screenshot_target_language")]
    pub target_language: String,
    #[serde(default)]
    pub ocr_ai_enabled: bool,
    pub ocr_method: OcrMethod,
    pub translation_method: TranslationMethod,
    #[serde(default)]
    pub translation_ai_enabled: bool,
    pub ocr_model: Option<ModelSelection>,
    pub translation_model: Option<ModelSelection>,
    pub show_source: bool,
    pub keep_fullscreen: bool,
    pub stream: bool,
    pub thinking: bool,
    pub thinking_effort: ThinkingEffort,
    pub ocr_prompt: String,
    pub translation_prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionSettings {
    pub enabled: bool,
    pub response_language: String,
    pub model: Option<ModelSelection>,
    pub stream: bool,
    pub thinking: bool,
    pub thinking_effort: ThinkingEffort,
    pub web_search: bool,
    pub message_order: MessageOrder,
    pub keep_fullscreen: bool,
    pub system_prompt: String,
    pub question_prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOptimizerSettings {
    pub enabled: bool,
    pub response_language: String,
    pub model: Option<ModelSelection>,
    #[serde(default = "default_thinking_effort")]
    pub thinking_effort: ThinkingEffort,
    pub system_prompt: String,
    pub optimize_prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExport {
    #[serde(rename = "type")]
    pub export_type: String,
    pub schema_version: u8,
    pub app_version: String,
    pub exported_at: String,
    pub includes_secrets: bool,
    pub settings: AppSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<SettingsSecrets>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSecrets {
    pub schema_version: u8,
    pub providers: HashMap<String, Vec<String>>,
    pub adapters: HashMap<String, Vec<String>>,
}

impl SettingsSecrets {
    pub fn new(
        providers: HashMap<String, Vec<String>>,
        adapters: HashMap<String, Vec<String>>,
    ) -> Self {
        Self {
            schema_version: SETTINGS_SECRETS_SCHEMA_VERSION,
            providers,
            adapters,
        }
    }
}

impl<'de> Deserialize<'de> for SettingsSecrets {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct VersionedSecrets {
            schema_version: u8,
            #[serde(default)]
            providers: HashMap<String, Vec<String>>,
            #[serde(default)]
            adapters: HashMap<String, Vec<String>>,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum SecretsWire {
            Versioned(VersionedSecrets),
            Legacy(HashMap<String, Vec<String>>),
        }

        match SecretsWire::deserialize(deserializer)? {
            SecretsWire::Versioned(value) => Ok(Self {
                schema_version: value.schema_version,
                providers: value.providers,
                adapters: value.adapters,
            }),
            SecretsWire::Legacy(providers) => Ok(Self::new(providers, HashMap::new())),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            theme: ThemeMode::System,
            language: InterfaceLanguage::Zh,
            retry: RetrySettings {
                enabled: true,
                attempts: 3,
            },
            general: GeneralSettings {
                auto_paste: true,
                launch_at_startup: false,
                launch_at_startup_as_administrator: false,
                image_archive_enabled: false,
                image_archive_path: String::new(),
            },
            shortcuts: ShortcutSettings {
                translator: "F2".into(),
                vision: "F3".into(),
                screenshot_translation: "F4".into(),
                prompt_optimizer: "Control+Alt+P".into(),
            },
            translation: TranslationSettings {
                source_language: default_source_language(),
                target_language: "auto".into(),
                method: TranslationMethod::Microsoft,
                ai_enabled: false,
                ai_model: None,
                prompt: TRANSLATION_PROMPT.into(),
            },
            screenshot_translation: ScreenshotTranslationSettings {
                enabled: true,
                source_language: default_source_language(),
                target_language: default_screenshot_target_language(),
                ocr_ai_enabled: false,
                ocr_method: OcrMethod::Chaoxing,
                translation_method: TranslationMethod::Microsoft,
                translation_ai_enabled: false,
                ocr_model: None,
                translation_model: None,
                show_source: true,
                keep_fullscreen: false,
                stream: true,
                thinking: false,
                thinking_effort: ThinkingEffort::Medium,
                ocr_prompt: OCR_PROMPT.into(),
                translation_prompt: SCREENSHOT_TRANSLATION_PROMPT.into(),
            },
            vision: VisionSettings {
                enabled: true,
                response_language: "auto".into(),
                model: None,
                stream: true,
                thinking: true,
                thinking_effort: ThinkingEffort::Medium,
                web_search: true,
                message_order: MessageOrder::Asc,
                keep_fullscreen: false,
                system_prompt: VISION_SYSTEM_PROMPT.into(),
                question_prompt: VISION_QUESTION_PROMPT.into(),
            },
            prompt_optimizer: PromptOptimizerSettings {
                enabled: true,
                response_language: "auto".into(),
                model: None,
                thinking_effort: ThinkingEffort::Medium,
                system_prompt: OPTIMIZER_SYSTEM_PROMPT.into(),
                optimize_prompt: OPTIMIZER_PROMPT.into(),
            },
            providers: Vec::new(),
        }
    }
}

impl AppSettings {
    pub fn migrate_missing_ai_toggles(&mut self, raw: &serde_json::Value) {
        let providers = &self.providers;
        let translation = raw
            .get("translation")
            .and_then(serde_json::Value::as_object);
        if !translation.is_some_and(|value| value.contains_key("aiEnabled")) {
            self.translation.ai_enabled = self
                .translation
                .ai_model
                .as_ref()
                .is_some_and(|selection| valid_model_selection(providers, selection));
        }
        let screenshot = raw
            .get("screenshotTranslation")
            .and_then(serde_json::Value::as_object);
        if !screenshot.is_some_and(|value| value.contains_key("ocrAiEnabled")) {
            self.screenshot_translation.ocr_ai_enabled = self
                .screenshot_translation
                .ocr_model
                .as_ref()
                .is_some_and(|selection| valid_model_selection(providers, selection));
        }
        if !screenshot.is_some_and(|value| value.contains_key("translationAiEnabled")) {
            self.screenshot_translation.translation_ai_enabled = self
                .screenshot_translation
                .translation_model
                .as_ref()
                .is_some_and(|selection| valid_model_selection(providers, selection));
        }
        self.normalize_ai_options();
    }

    pub fn normalize_ai_options(&mut self) {
        if !valid_optional_model_selection(&self.providers, &mut self.translation.ai_model) {
            self.translation.ai_model = None;
        }
        if !valid_optional_model_selection(
            &self.providers,
            &mut self.screenshot_translation.ocr_model,
        ) {
            self.screenshot_translation.ocr_model = None;
        }
        if !valid_optional_model_selection(
            &self.providers,
            &mut self.screenshot_translation.translation_model,
        ) {
            self.screenshot_translation.translation_model = None;
        }
        if self.translation.method == TranslationMethod::Ai
            && !(self.translation.ai_enabled && self.translation.ai_model.is_some())
        {
            self.translation.method = TranslationMethod::Microsoft;
        }
        if self.screenshot_translation.ocr_method == OcrMethod::Ai
            && !(self.screenshot_translation.ocr_ai_enabled
                && self.screenshot_translation.ocr_model.is_some())
        {
            self.screenshot_translation.ocr_method = OcrMethod::Chaoxing;
        }
        if self.screenshot_translation.translation_method == TranslationMethod::Ai
            && !(self.screenshot_translation.translation_ai_enabled
                && self.screenshot_translation.translation_model.is_some())
        {
            self.screenshot_translation.translation_method = TranslationMethod::Microsoft;
        }
        #[cfg(target_os = "windows")]
        if self.screenshot_translation.ocr_method == OcrMethod::System {
            self.screenshot_translation.ocr_method = OcrMethod::Chaoxing;
        }
    }

    pub fn migrate_prompt_defaults(&mut self) {
        if self.translation.prompt == LEGACY_TRANSLATION_PROMPT {
            self.translation.prompt = TRANSLATION_PROMPT.into();
        }
        if self.screenshot_translation.ocr_prompt == LEGACY_OCR_PROMPT {
            self.screenshot_translation.ocr_prompt = OCR_PROMPT.into();
        }
        if self.screenshot_translation.translation_prompt == LEGACY_SCREENSHOT_TRANSLATION_PROMPT {
            self.screenshot_translation.translation_prompt = SCREENSHOT_TRANSLATION_PROMPT.into();
        }
        if self.vision.system_prompt == LEGACY_VISION_SYSTEM_PROMPT {
            self.vision.system_prompt = VISION_SYSTEM_PROMPT.into();
        }
        if self.vision.question_prompt == LEGACY_VISION_QUESTION_PROMPT {
            self.vision.question_prompt = VISION_QUESTION_PROMPT.into();
        }
        if self.prompt_optimizer.system_prompt == LEGACY_OPTIMIZER_SYSTEM_PROMPT {
            self.prompt_optimizer.system_prompt = OPTIMIZER_SYSTEM_PROMPT.into();
        }
        if self.prompt_optimizer.optimize_prompt == LEGACY_OPTIMIZER_PROMPT {
            self.prompt_optimizer.optimize_prompt = OPTIMIZER_PROMPT.into();
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err("Unsupported settings schema".into());
        }
        if !(1..=5).contains(&self.retry.attempts) {
            return Err("Retry attempts must be between 1 and 5".into());
        }
        if self.general.image_archive_enabled && self.general.image_archive_path.trim().is_empty() {
            return Err("Screenshot archive path cannot be empty when archiving is enabled".into());
        }
        if !matches!(
            self.translation.source_language.as_str(),
            "auto" | "zh-CN" | "en" | "ja" | "ko"
        ) {
            return Err("Text translation source language is unsupported".into());
        }
        if !matches!(
            self.translation.target_language.as_str(),
            "auto" | "zh-CN" | "en" | "ja" | "ko"
        ) {
            return Err("Text translation target language is unsupported".into());
        }
        if !matches!(
            self.screenshot_translation.source_language.as_str(),
            "auto" | "zh-CN" | "en" | "ja" | "ko"
        ) {
            return Err("Screenshot translation source language is unsupported".into());
        }
        if !matches!(
            self.screenshot_translation.target_language.as_str(),
            "auto" | "zh-CN" | "en" | "ja" | "ko"
        ) {
            return Err("Screenshot translation target language is unsupported".into());
        }
        let mut shortcuts = vec![self.shortcuts.translator.as_str()];
        if self.vision.enabled {
            shortcuts.push(self.shortcuts.vision.as_str());
        }
        if self.screenshot_translation.enabled {
            shortcuts.push(self.shortcuts.screenshot_translation.as_str());
        }
        if self.prompt_optimizer.enabled {
            shortcuts.push(self.shortcuts.prompt_optimizer.as_str());
        }
        if shortcuts.iter().any(|value| value.trim().is_empty()) {
            return Err("Shortcuts cannot be empty".into());
        }
        let shortcut_count = shortcuts
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<HashSet<_>>()
            .len();
        if shortcut_count != shortcuts.len() {
            return Err("Shortcuts must be unique".into());
        }
        let mut provider_ids = HashSet::new();
        for provider in &self.providers {
            if provider.id.trim().is_empty() || !provider_ids.insert(provider.id.clone()) {
                return Err("Provider ids must be non-empty and unique".into());
            }
            if provider.name.trim().is_empty() {
                return Err("Provider names cannot be empty".into());
            }
            let endpoint = Url::parse(&provider.base_url).map_err(|_| "Provider URL is invalid")?;
            let local = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
            if endpoint.scheme() != "https" && !(local && endpoint.scheme() == "http") {
                return Err("Provider URL must use HTTPS".into());
            }
        }
        Ok(())
    }
}

fn default_screenshot_target_language() -> String {
    "auto".into()
}

fn default_source_language() -> String {
    "auto".into()
}

fn default_thinking_effort() -> ThinkingEffort {
    ThinkingEffort::Medium
}

fn valid_model_selection(providers: &[ProviderSettings], selection: &ModelSelection) -> bool {
    providers
        .iter()
        .find(|provider| provider.id == selection.provider_id)
        .is_some_and(|provider| provider.enabled_models.contains(&selection.model))
}

fn valid_optional_model_selection(
    providers: &[ProviderSettings],
    selection: &mut Option<ModelSelection>,
) -> bool {
    selection
        .as_ref()
        .is_some_and(|value| valid_model_selection(providers, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_round_trip_as_frontend_shape() {
        let settings = AppSettings::default();
        let json = serde_json::to_value(&settings).expect("serialize defaults");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["shortcuts"]["promptOptimizer"], "Control+Alt+P");
        assert_eq!(json["screenshotTranslation"]["ocrMethod"], "chaoxing");
        assert_eq!(json["promptOptimizer"]["thinkingEffort"], "medium");
        assert_eq!(json["translation"]["aiEnabled"], false);
        assert_eq!(json["translation"]["sourceLanguage"], "auto");
        assert_eq!(json["screenshotTranslation"]["ocrAiEnabled"], false);
        assert_eq!(json["screenshotTranslation"]["translationAiEnabled"], false);
        assert_eq!(json["screenshotTranslation"]["targetLanguage"], "auto");
        assert_eq!(json["screenshotTranslation"]["sourceLanguage"], "auto");
        assert!(json["screenshotTranslation"]["ocrPrompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("copy-ready Markdown")));
        assert!(json["screenshotTranslation"]["translationPrompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("{lang}") && prompt.contains("{text}")));
        assert!(json["vision"]["systemPrompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("能够看到用户分享的截图")));
        assert_eq!(
            serde_json::from_value::<AppSettings>(json).expect("deserialize"),
            settings
        );
    }

    #[test]
    fn fills_missing_screenshot_target_language() {
        let settings = AppSettings::default();
        let mut json = serde_json::to_value(settings).expect("serialize defaults");
        json["screenshotTranslation"]
            .as_object_mut()
            .expect("screenshot settings")
            .remove("targetLanguage");
        let restored = serde_json::from_value::<AppSettings>(json).expect("deserialize legacy");
        assert_eq!(restored.screenshot_translation.target_language, "auto");
    }

    #[test]
    fn fills_missing_source_languages() {
        let settings = AppSettings::default();
        let mut json = serde_json::to_value(settings).expect("serialize defaults");
        let translation = json["translation"]
            .as_object_mut()
            .expect("translation settings");
        translation.remove("sourceLanguage");
        let screenshot = json["screenshotTranslation"]
            .as_object_mut()
            .expect("screenshot settings");
        screenshot.remove("sourceLanguage");
        let restored = serde_json::from_value::<AppSettings>(json).expect("deserialize legacy");
        assert_eq!(restored.translation.source_language, "auto");
        assert_eq!(restored.screenshot_translation.source_language, "auto");
    }

    #[test]
    fn fills_missing_prompt_optimizer_thinking_effort() {
        let settings = AppSettings::default();
        let mut json = serde_json::to_value(settings).expect("serialize defaults");
        json["promptOptimizer"]
            .as_object_mut()
            .expect("prompt optimizer settings")
            .remove("thinkingEffort");
        let restored = serde_json::from_value::<AppSettings>(json).expect("deserialize legacy");
        assert_eq!(
            restored.prompt_optimizer.thinking_effort,
            ThinkingEffort::Medium
        );
    }

    #[test]
    fn serializes_max_thinking_effort_as_lowercase_max() {
        assert_eq!(
            serde_json::to_value(ThinkingEffort::Max).expect("serialize max effort"),
            serde_json::Value::String("max".into())
        );
        assert_eq!(
            serde_json::from_value::<ThinkingEffort>(serde_json::json!("max"))
                .expect("deserialize max effort"),
            ThinkingEffort::Max
        );
    }

    #[test]
    fn rejects_duplicate_shortcuts_and_unsafe_provider_url() {
        let mut settings = AppSettings::default();
        settings.shortcuts.vision = "f2".into();
        assert_eq!(settings.validate().unwrap_err(), "Shortcuts must be unique");
        settings.shortcuts.vision = "F3".into();
        settings.providers.push(ProviderSettings {
            id: "remote".into(),
            name: "Remote".into(),
            base_url: "http://example.com/v1".into(),
            key_count: 0,
            available_models: Vec::new(),
            enabled_models: Vec::new(),
        });
        assert_eq!(
            settings.validate().unwrap_err(),
            "Provider URL must use HTTPS"
        );
    }

    #[test]
    fn rejects_enabled_screenshot_archiving_without_a_directory() {
        let mut settings = AppSettings::default();
        settings.general.image_archive_enabled = true;
        settings.general.image_archive_path = "  ".into();
        assert_eq!(
            settings.validate(),
            Err("Screenshot archive path cannot be empty when archiving is enabled".into())
        );
    }

    #[test]
    fn migrates_only_untouched_prompt_defaults() {
        let mut settings = AppSettings::default();
        settings.translation.prompt = LEGACY_TRANSLATION_PROMPT.into();
        settings.screenshot_translation.ocr_prompt = LEGACY_OCR_PROMPT.into();
        settings.screenshot_translation.translation_prompt =
            LEGACY_SCREENSHOT_TRANSLATION_PROMPT.into();
        settings.vision.system_prompt = LEGACY_VISION_SYSTEM_PROMPT.into();
        settings.vision.question_prompt = "custom question".into();
        settings.prompt_optimizer.system_prompt = LEGACY_OPTIMIZER_SYSTEM_PROMPT.into();
        settings.prompt_optimizer.optimize_prompt = "custom optimizer prompt".into();
        settings.migrate_prompt_defaults();
        assert_eq!(settings.translation.prompt, TRANSLATION_PROMPT);
        assert_eq!(settings.screenshot_translation.ocr_prompt, OCR_PROMPT);
        assert_eq!(
            settings.screenshot_translation.translation_prompt,
            SCREENSHOT_TRANSLATION_PROMPT
        );
        assert_eq!(settings.vision.system_prompt, VISION_SYSTEM_PROMPT);
        assert_eq!(settings.vision.question_prompt, "custom question");
        assert_eq!(
            settings.prompt_optimizer.system_prompt,
            OPTIMIZER_SYSTEM_PROMPT
        );
        assert_eq!(
            settings.prompt_optimizer.optimize_prompt,
            "custom optimizer prompt"
        );
    }

    #[test]
    fn migrates_legacy_ai_toggles_from_enabled_models() {
        let mut settings = AppSettings::default();
        settings.providers.push(ProviderSettings {
            id: "provider".into(),
            name: "Provider".into(),
            base_url: "https://example.com/v1".into(),
            key_count: 0,
            available_models: vec!["model".into()],
            enabled_models: vec!["model".into()],
        });
        settings.translation.method = TranslationMethod::Ai;
        settings.translation.ai_model = Some(ModelSelection {
            provider_id: "provider".into(),
            model: "model".into(),
        });
        settings.screenshot_translation.ocr_method = OcrMethod::Ai;
        settings.screenshot_translation.ocr_model = settings.translation.ai_model.clone();
        settings.screenshot_translation.translation_method = TranslationMethod::Ai;
        settings.screenshot_translation.translation_model = settings.translation.ai_model.clone();
        let mut raw = serde_json::to_value(&settings).expect("serialize");
        raw.get_mut("translation")
            .and_then(serde_json::Value::as_object_mut)
            .expect("translation object")
            .remove("aiEnabled");
        raw.get_mut("screenshotTranslation")
            .and_then(serde_json::Value::as_object_mut)
            .expect("screenshot object")
            .remove("ocrAiEnabled");
        raw.get_mut("screenshotTranslation")
            .and_then(serde_json::Value::as_object_mut)
            .expect("screenshot object")
            .remove("translationAiEnabled");
        let mut restored = serde_json::from_value::<AppSettings>(raw.clone()).expect("deserialize");
        restored.migrate_missing_ai_toggles(&raw);
        assert!(restored.translation.ai_enabled);
        assert!(restored.screenshot_translation.ocr_ai_enabled);
        assert!(restored.screenshot_translation.translation_ai_enabled);
        assert_eq!(restored.translation.method, TranslationMethod::Ai);
        assert_eq!(restored.screenshot_translation.ocr_method, OcrMethod::Ai);
        assert_eq!(
            restored.screenshot_translation.translation_method,
            TranslationMethod::Ai
        );
    }

    #[test]
    fn normalizes_ai_methods_after_provider_model_removal() {
        let mut settings = AppSettings::default();
        settings.translation.ai_enabled = true;
        settings.translation.method = TranslationMethod::Ai;
        settings.translation.ai_model = Some(ModelSelection {
            provider_id: "missing".into(),
            model: "model".into(),
        });
        settings.screenshot_translation.ocr_ai_enabled = true;
        settings.screenshot_translation.ocr_method = OcrMethod::Ai;
        settings.screenshot_translation.ocr_model = settings.translation.ai_model.clone();
        settings.screenshot_translation.translation_ai_enabled = true;
        settings.screenshot_translation.translation_method = TranslationMethod::Ai;
        settings.screenshot_translation.translation_model = settings.translation.ai_model.clone();
        settings.normalize_ai_options();
        assert_eq!(settings.translation.method, TranslationMethod::Microsoft);
        assert_eq!(
            settings.screenshot_translation.ocr_method,
            OcrMethod::Chaoxing
        );
        assert_eq!(
            settings.screenshot_translation.translation_method,
            TranslationMethod::Microsoft
        );
        assert!(settings.translation.ai_model.is_none());
        assert!(settings.screenshot_translation.ocr_model.is_none());
        assert!(settings.screenshot_translation.translation_model.is_none());
    }

    #[test]
    fn ignores_shortcut_conflicts_for_disabled_features() {
        let mut settings = AppSettings::default();
        settings.vision.enabled = false;
        settings.shortcuts.vision = settings.shortcuts.translator.clone();
        settings.validate().expect("disabled shortcut is inactive");

        settings.vision.enabled = true;
        assert_eq!(settings.validate(), Err("Shortcuts must be unique".into()));
    }

    #[test]
    fn settings_secrets_serialize_with_an_independent_schema_version() {
        let secrets = SettingsSecrets::new(
            HashMap::from([("provider-a".into(), vec!["provider-secret".into()])]),
            HashMap::from([("adapter-caiyun-translation".into(), vec!["token".into()])]),
        );

        assert_eq!(
            serde_json::to_value(secrets).expect("serialize secrets"),
            json!({
                "schemaVersion": SETTINGS_SECRETS_SCHEMA_VERSION,
                "providers": {"provider-a": ["provider-secret"]},
                "adapters": {"adapter-caiyun-translation": ["token"]}
            })
        );
    }

    #[test]
    fn settings_secrets_accept_legacy_flat_provider_maps() {
        let secrets = serde_json::from_value::<SettingsSecrets>(json!({
            "provider-a": ["legacy-secret"]
        }))
        .expect("deserialize legacy secrets");

        assert_eq!(secrets.schema_version, SETTINGS_SECRETS_SCHEMA_VERSION);
        assert_eq!(
            secrets.providers,
            HashMap::from([("provider-a".into(), vec!["legacy-secret".into()])])
        );
        assert!(secrets.adapters.is_empty());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalizes_unavailable_windows_system_ocr() {
        let mut settings = AppSettings::default();
        settings.screenshot_translation.ocr_method = OcrMethod::System;
        settings.normalize_ai_options();
        assert_eq!(
            settings.screenshot_translation.ocr_method,
            OcrMethod::Chaoxing
        );
    }
}
