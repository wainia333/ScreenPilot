use serde::{Deserialize, Serialize};
use url::Url;

pub fn default_karakeep_system_prompt() -> String {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PromptDefaults {
        system_prompt: String,
    }
    serde_json::from_str::<PromptDefaults>(include_str!("karakeep-system-prompt.json"))
        .expect("embedded KaraKeep prompt must be valid JSON")
        .system_prompt
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    Fts,
    Semantic,
    Hybrid,
}
impl SearchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fts => "fts",
            Self::Semantic => "semantic",
            Self::Hybrid => "hybrid",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SourcePolicy {
    Off,
    #[default]
    Auto,
    Only,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct KarakeepConfig {
    pub enabled: bool,
    pub base_url: String,
    pub instance_id: String,
    pub default_search_mode: SearchMode,
    pub vision_policy: SourcePolicy,
    pub system_prompt: String,
}
impl Default for KarakeepConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: String::new(),
            instance_id: String::new(),
            default_search_mode: SearchMode::default(),
            vision_policy: SourcePolicy::default(),
            system_prompt: default_karakeep_system_prompt(),
        }
    }
}
pub fn instance_url(value: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|_| "KARAKEEP_CONFIG: 请输入有效的 HTTPS 实例地址")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "KARAKEEP_CONFIG: 地址必须使用 HTTPS，不能包含用户名、密码、查询参数或片段".into(),
        );
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}
pub fn safe_link(value: Option<&str>) -> Option<String> {
    let value = value?;
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| value.to_string())
}
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}
#[derive(Clone, Debug, Deserialize)]
pub struct ApiTag {
    pub name: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: Option<String>,
    pub source_url: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub text: Option<String>,
    pub html_content: Option<String>,
    pub content: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ApiBookmark {
    pub id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<ApiTag>,
    pub content: ApiContent,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSearch {
    pub bookmarks: Vec<ApiBookmark>,
    pub next_cursor: Option<String>,
}
#[derive(Deserialize)]
pub struct ApiContentRange {
    pub start: usize,
    pub end: usize,
    pub total: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiReadable {
    pub bookmark_id: String,
    pub bookmark_type: String,
    pub format: String,
    pub content: String,
    pub content_version: String,
    pub range: ApiContentRange,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub passage_id: String,
    pub quote: String,
    pub content_version: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkReference {
    pub instance_id: String,
    pub bookmark_id: String,
    pub title: String,
    pub content_type: String,
    pub source_url: Option<String>,
    pub karakeep_url: Option<String>,
    pub tags: Vec<String>,
    pub reason: String,
    pub evidence: Vec<Evidence>,
    pub verification: String,
    pub applicability: Option<String>,
    pub retrieved_at: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRunSummary {
    pub run_id: String,
    pub requested_mode: SearchMode,
    pub effective_mode: String,
    pub status: String,
    pub read_count: usize,
    pub recommendation_count: usize,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalBookmark {
    pub instance_id: String,
    pub bookmark_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_settings_get_the_current_prompt_and_custom_prompts_round_trip() {
        let legacy: KarakeepConfig = serde_json::from_value(serde_json::json!({
            "enabled": true, "baseUrl": "https://saved.example/", "visionPolicy": "only"
        }))
        .unwrap();
        assert_eq!(legacy.system_prompt, default_karakeep_system_prompt());
        assert_eq!(legacy.vision_policy, SourcePolicy::Only);
        let custom = KarakeepConfig {
            system_prompt: "优先推荐能直接在线使用的工具。".into(),
            ..legacy
        };
        let restored: KarakeepConfig =
            serde_json::from_value(serde_json::to_value(&custom).unwrap()).unwrap();
        assert_eq!(restored, custom);
    }
    #[test]
    fn rejects_credential_urls_and_preserves_subpaths() {
        assert_eq!(
            instance_url("https://example.org/saved///")
                .unwrap()
                .as_str(),
            "https://example.org/saved/"
        );
        for value in [
            "https://key@example.org",
            "https://example.org?token=x",
            "http://example.org",
            "file:///x",
        ] {
            assert!(instance_url(value).is_err());
        }
        assert!(!valid_id("../search"));
    }
}
