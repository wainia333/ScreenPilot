use crate::application::state::CancellationSignal;
use crate::domain::integrations::karakeep::*;
use crate::infrastructure::provider_http::{read_json_limited, send_request};
use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
pub struct KarakeepService {
    base: Url,
    key: String,
}
pub struct SearchPage<'a> {
    pub cursor: Option<&'a str>,
    pub sort_order: &'a str,
}
impl KarakeepService {
    pub fn new(base: &str, key: String) -> Result<Self, String> {
        if key.trim().is_empty() || key.len() > 16384 {
            return Err("KARAKEEP_AUTH: 请在资料来源设置中配置 API Key".into());
        }
        Ok(Self {
            base: instance_url(base)?,
            key,
        })
    }
    pub fn instance_id(&self) -> String {
        self.base.to_string()
    }
    fn endpoint(&self, suffix: &str) -> Result<Url, String> {
        self.base
            .join(&format!("api/v1/{suffix}"))
            .map_err(|_| "KARAKEEP_CONFIG: API 地址无效".into())
    }
    async fn get<T: DeserializeOwned>(
        &self,
        url: Url,
        signal: &CancellationSignal,
    ) -> Result<T, String> {
        let client = CLIENT
            .get_or_init(|| {
                Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(10))
                    .timeout(Duration::from_secs(20))
                    .user_agent(concat!("ScreenPilot/", env!("CARGO_PKG_VERSION")))
                    .build()
                    .map_err(|_| "KARAKEEP_CONNECTION: 无法创建 HTTP 客户端".into())
            })
            .as_ref()
            .map_err(Clone::clone)?;
        let response = send_request(client.get(url).bearer_auth(&self.key), Some(signal))
            .await
            .map_err(|e| -> String {
                if signal.is_cancelled() {
                    "KARAKEEP_CANCELLED: 已取消".into()
                } else if e.contains("timeout") {
                    "KARAKEEP_TIMEOUT: 收藏库请求超时".into()
                } else {
                    "KARAKEEP_CONNECTION: 无法连接收藏库，请检查地址、网络及证书".into()
                }
            })?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err("KARAKEEP_AUTH: API Key 无效或无读取权限".into())
            }
            StatusCode::NOT_FOUND => {
                return Err("KARAKEEP_NOT_FOUND: 书签已删除，或此版本不支持该 API".into())
            }
            StatusCode::BAD_REQUEST | StatusCode::CONFLICT => {
                return Err("KARAKEEP_API: 参数或正文版本不兼容，请检查服务端版本".into())
            }
            status if status.is_redirection() => {
                return Err(
                    "KARAKEEP_REDIRECT: 请使用实例的最终地址；已阻止携带密钥的重定向".into(),
                )
            }
            status if !status.is_success() => {
                return Err(format!("KARAKEEP_API: 服务端返回 HTTP {}", status.as_u16()))
            }
            _ => {}
        }
        read_json_limited(response, RESPONSE_LIMIT, "Karakeep response", Some(signal))
            .await
            .map_err(|error| {
                if signal.is_cancelled() {
                    "KARAKEEP_CANCELLED: 已取消".into()
                } else if error.contains("timeout") {
                    "KARAKEEP_TIMEOUT: 收藏库正文接收超时".into()
                } else {
                    "KARAKEEP_API: 响应格式无效或超过 2 MiB 限制".into()
                }
            })
    }
    pub async fn search(
        &self,
        query: &str,
        mode: SearchMode,
        limit: usize,
        cursor: Option<&str>,
        signal: &CancellationSignal,
    ) -> Result<ApiSearch, String> {
        self.search_sorted(
            query,
            mode,
            limit,
            SearchPage {
                cursor,
                sort_order: "relevance",
            },
            signal,
        )
        .await
    }
    pub async fn search_sorted(
        &self,
        query: &str,
        mode: SearchMode,
        limit: usize,
        page: SearchPage<'_>,
        signal: &CancellationSignal,
    ) -> Result<ApiSearch, String> {
        if query.trim().is_empty()
            || query.len() > 2000
            || page.cursor.is_some_and(|s| s.len() > 4096)
        {
            return Err("KARAKEEP_ARGUMENT: 查询或游标无效".into());
        }
        let mut url = self.endpoint("bookmarks/search")?;
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("searchMode", mode.as_str())
            .append_pair("sortOrder", page.sort_order)
            .append_pair("limit", &limit.clamp(1, 20).to_string())
            .append_pair("includeContent", "false");
        if let Some(cursor) = page.cursor {
            url.query_pairs_mut().append_pair("cursor", cursor);
        }
        let mut result: ApiSearch = self.get(url, signal).await?;
        if result.bookmarks.len() > 100
            || result.next_cursor.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err("KARAKEEP_API: 搜索响应超过上限".into());
        }
        if result.bookmarks.iter().any(|b| !valid_id(&b.id)) {
            return Err("KARAKEEP_API: 搜索结果包含无效 ID".into());
        }
        result.bookmarks.truncate(limit.clamp(1, 20));
        Ok(result)
    }
    pub async fn detail(
        &self,
        id: &str,
        signal: &CancellationSignal,
    ) -> Result<ApiBookmark, String> {
        self.detail_content(id, false, signal).await
    }
    async fn detail_content(
        &self,
        id: &str,
        include_content: bool,
        signal: &CancellationSignal,
    ) -> Result<ApiBookmark, String> {
        if !valid_id(id) {
            return Err("KARAKEEP_ARGUMENT: 无效书签 ID".into());
        }
        let mut url = self.endpoint(&format!("bookmarks/{id}"))?;
        url.query_pairs_mut().append_pair(
            "includeContent",
            if include_content { "true" } else { "false" },
        );
        let b: ApiBookmark = self.get(url, signal).await?;
        if b.id != id {
            return Err("KARAKEEP_API: 详情 ID 不匹配".into());
        }
        Ok(b)
    }
    pub async fn readable(
        &self,
        id: &str,
        signal: &CancellationSignal,
    ) -> Result<(String, Option<String>, bool), String> {
        if !valid_id(id) {
            return Err("KARAKEEP_ARGUMENT: 无效书签 ID".into());
        }
        // Match the official get-bookmark-content API path first. Rank the entire
        // bounded HTTP payload later; cutting the head here hides links in long directories.
        match self.detail_content(id, true, signal).await {
            Ok(bookmark) => {
                let raw = match bookmark.content.kind.as_str() {
                    "text" => bookmark.content.text,
                    "asset" => bookmark.content.content,
                    "link" => bookmark.content.html_content,
                    _ => return Err("KARAKEEP_CONTENT: 不支持的书签类型".into()),
                };
                if let Some(raw) = raw {
                    let text = if bookmark.content.kind == "link" {
                        html_markdown(&raw)?
                    } else {
                        raw
                    };
                    return Ok((text, None, false));
                }
            }
            Err(error) if error.starts_with("KARAKEEP_NOT_FOUND") => {}
            Err(error) => return Err(error),
        }
        // Compatibility with instances exposing readable content independently.
        self.readable_pages(id, signal).await
    }
    async fn readable_pages(
        &self,
        id: &str,
        signal: &CancellationSignal,
    ) -> Result<(String, Option<String>, bool), String> {
        let mut text = String::new();
        let mut cursor: Option<String> = None;
        let mut version = None;
        let mut truncated = false;
        let mut expected_start = 0;
        let mut expected_total = None;
        for _ in 0..2 {
            let mut url = self.endpoint(&format!("bookmarks/{id}/content"))?;
            url.query_pairs_mut()
                .append_pair("format", "markdown")
                .append_pair("maxChars", "12000");
            if let Some(c) = cursor.as_ref() {
                url.query_pairs_mut().append_pair("cursor", c);
            }
            let page: ApiReadable = match self.get(url, signal).await {
                Ok(page) => page,
                Err(e) if e.starts_with("KARAKEEP_NOT_FOUND") && text.is_empty() => {
                    let b = self.detail_content(id, true, signal).await?;
                    let raw = match b.content.kind.as_str() {
                        "text" => b.content.text.unwrap_or_default(),
                        "asset" => b.content.content.unwrap_or_default(),
                        _ => html_markdown(&b.content.html_content.unwrap_or_default())?,
                    };
                    let cut = raw.chars().count() > 24000;
                    return Ok((raw.chars().take(24000).collect(), None, cut));
                }
                Err(e) => return Err(e),
            };
            if page.bookmark_id != id
                || !matches!(page.bookmark_type.as_str(), "link" | "text" | "asset")
                || page.format != "markdown"
                || version.as_ref().is_some_and(|v| v != &page.content_version)
                || page.content_version.is_empty()
                || page.content_version.len() > 1024
                || page.content.chars().count() > 12000
                || page.next_cursor.as_ref().is_some_and(|c| c.len() > 4096)
                || page.range.start != expected_start
                || page.range.end < page.range.start
                || page.range.end > page.range.total
                || page.range.end - page.range.start != page.content.chars().count()
                || expected_total.is_some_and(|total| total != page.range.total)
                || page.truncated != (page.range.end < page.range.total)
                || page.next_cursor.is_some() != page.truncated
            {
                return Err("KARAKEEP_API: 正文 ID、格式、版本、分页范围或长度无效".into());
            }
            expected_start = page.range.end;
            expected_total = Some(page.range.total);
            version = Some(page.content_version);
            text.push_str(&page.content);
            truncated = page.truncated;
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok((
            text.chars().take(24000).collect(),
            version,
            truncated || cursor.is_some(),
        ))
    }
    pub fn reference(&self, b: &ApiBookmark) -> BookmarkReference {
        BookmarkReference {
            instance_id: self.instance_id(),
            bookmark_id: b.id.clone(),
            title: b
                .title
                .as_ref()
                .or(b.content.title.as_ref())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.chars().take(300).collect())
                .unwrap_or_else(|| "未命名书签".into()),
            content_type: b.content.kind.clone(),
            source_url: safe_link(b.content.url.as_deref().or(b.content.source_url.as_deref())),
            // v0.33.1 exposes the detail modal via dashboard/preview/<bookmarkId>.
            karakeep_url: self
                .base
                .join(&format!("dashboard/preview/{}", b.id))
                .ok()
                .map(|u| u.to_string()),
            tags: b
                .tags
                .iter()
                .take(8)
                .map(|t| t.name.chars().take(80).collect())
                .collect(),
            reason: String::new(),
            evidence: Vec::new(),
            verification: "metadata".into(),
            applicability: None,
            retrieved_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

fn html_markdown(html: &str) -> Result<String, String> {
    let rendered = html2text::config::plain()
        .no_link_wrapping()
        .string_from_read(html.as_bytes(), 100)
        .map_err(|_| "KARAKEEP_CONTENT: 无法解析正文 HTML")?;
    // Keep a directory's link beside its label when excerpts are selected.
    // Otherwise a footnote at the end can be dropped independently of the feature.
    let links: HashMap<_, _> = rendered
        .lines()
        .filter_map(|line| {
            let (id, url) = line.strip_prefix('[')?.split_once("]: ")?;
            (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some((id, url))
        })
        .collect();
    let body = rendered
        .lines()
        .filter(|line| {
            !line
                .strip_prefix('[')
                .and_then(|s| s.split_once("]: "))
                .is_some_and(|(id, _)| links.contains_key(id))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut rest = body.as_str();
    let mut output = String::with_capacity(body.len());
    while let Some(start) = rest.find("][") {
        output.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find(']') {
            if let Some(url) = links.get(&rest[..end]) {
                output.push_str(&format!("](<{url}>)"));
                rest = &rest[end + 1..];
                continue;
            }
        }
        output.push_str("][");
    }
    output.push_str(rest);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{header, method, path, query_param},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn official_content_path_supports_html_text_assets_and_keeps_inline_links() {
        let server = MockServer::start().await;
        for (id,kind,field,raw,expected) in [
            ("link","link","htmlContent","<p><a href='https://tools.example/?id=5&amp;lang=zh'>SVG 编辑器</a>：打开 SVG 文件。</p>","https://tools.example/?id=5&lang=zh"),
            ("text","text","text","SVG 文本教程😀","SVG 文本教程😀"),
            ("asset","asset","content","媒体附件中的 SVG 编辑说明","媒体附件中的 SVG 编辑说明"),
        ] {
            let mut content=serde_json::json!({"type":kind});
            content[field]=serde_json::json!(raw);
            Mock::given(path(format!("/api/v1/bookmarks/{id}"))).and(query_param("includeContent","true"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id":id,"content":content}))).expect(1).mount(&server).await;
            let service=KarakeepService::new(&server.uri(),"key".into()).unwrap();
            let (text,version,truncated)=service.readable(id,&CancellationSignal::new()).await.unwrap();
            assert!(text.contains(expected));
            assert!(version.is_none());
            assert!(!truncated);
            if kind=="link" {
                assert!(text.contains("[SVG 编辑器](<https://tools.example/?id=5&lang=zh>)"));
                assert!(!text.contains("[1]:"));
            }
        }
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn rejects_invalid_content_format_and_discontinuous_ranges() {
        let server = MockServer::start().await;
        let service = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        let valid = serde_json::json!({"bookmarkId":"x","bookmarkType":"text","format":"markdown","content":"教程😀","contentVersion":"v1","range":{"start":0,"end":3,"total":3},"nextCursor":null,"truncated":false});
        for change in [
            serde_json::json!({"format":"html"}),
            serde_json::json!({"range":{"start":1,"end":4,"total":4}}),
            serde_json::json!({"range":{"start":0,"end":3,"total":2}}),
            serde_json::json!({"nextCursor":"unexpected"}),
        ] {
            server.reset().await;
            let mut body = valid.clone();
            for (key, value) in change.as_object().unwrap() {
                body[key] = value.clone();
            }
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            assert!(service
                .readable_pages("x", &CancellationSignal::new())
                .await
                .unwrap_err()
                .starts_with("KARAKEEP_API"));
        }
        server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid))
            .mount(&server)
            .await;
        assert_eq!(
            service
                .readable_pages("x", &CancellationSignal::new())
                .await
                .unwrap()
                .0,
            "教程😀"
        );
    }

    #[tokio::test]
    async fn rejects_oversized_responses_and_missing_required_fields() {
        let server = MockServer::start().await;
        let service = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        for body in [
            serde_json::json!({"nextCursor":null}),
            serde_json::json!({"bookmarks":[],"nextCursor":null,"padding":"x".repeat(RESPONSE_LIMIT)}),
        ] {
            server.reset().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            assert!(service
                .search(
                    "x",
                    SearchMode::Hybrid,
                    20,
                    None,
                    &CancellationSignal::new()
                )
                .await
                .unwrap_err()
                .starts_with("KARAKEEP_API"));
        }
    }

    #[tokio::test]
    async fn classifies_request_timeout_separately_from_empty_results() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(21)))
            .mount(&server)
            .await;
        let service = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        assert!(service
            .search(
                "x",
                SearchMode::Hybrid,
                20,
                None,
                &CancellationSignal::new()
            )
            .await
            .unwrap_err()
            .starts_with("KARAKEEP_TIMEOUT"));
    }

    #[tokio::test]
    async fn distinguishes_empty_auth_malformed_and_cancelled_results() {
        let server = MockServer::start().await;
        let service = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        for (status, body, prefix) in [
            (401, "{}", "KARAKEEP_AUTH"),
            (200, "{broken", "KARAKEEP_API"),
            (200, "{\"bookmarks\":[],\"nextCursor\":null}", ""),
        ] {
            server.reset().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(status).set_body_string(body))
                .mount(&server)
                .await;
            let result = service
                .search(
                    "x",
                    SearchMode::Hybrid,
                    20,
                    None,
                    &CancellationSignal::new(),
                )
                .await;
            if prefix.is_empty() {
                assert!(result.unwrap().bookmarks.is_empty());
            } else {
                assert!(result.unwrap_err().starts_with(prefix));
            }
        }
        server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        let signal = std::sync::Arc::new(CancellationSignal::new());
        let cancel = signal.clone();
        let request = async {
            service
                .search("x", SearchMode::Hybrid, 20, None, &signal)
                .await
        };
        let cancellation = async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            cancel.cancel();
        };
        let (result, _) = tokio::join!(request, cancellation);
        assert!(result.unwrap_err().starts_with("KARAKEEP_CANCELLED"));
    }
    #[tokio::test]
    async fn reads_bounded_markdown_pages_and_records_truncation() {
        let server = MockServer::start().await;
        let signal = CancellationSignal::new();
        Mock::given(path("/api/v1/bookmarks/x/content")).and(query_param("format","markdown")).and(query_param("maxChars","12000"))
            .respond_with(|r:&wiremock::Request| {
                let second=r.url.query_pairs().any(|(k,v)|k=="cursor"&&v=="next");
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"bookmarkId":"x","bookmarkType":"text","format":"markdown","content":if second{"second"}else{"first\n\n"},"contentVersion":"v1","range":{"start":if second{7}else{0},"end":if second{13}else{7},"total":13},"nextCursor":if second{None}else{Some("next")},"truncated":!second}))
            }).expect(2).mount(&server).await;
        let service = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        let (body, version, truncated) = service.readable("x", &signal).await.unwrap();
        assert_eq!(body, "first\n\nsecond");
        assert_eq!(version.as_deref(), Some("v1"));
        assert!(!truncated);
    }
    #[tokio::test]
    async fn sends_hybrid_query_to_subpath_and_handles_missing_optional_fields() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/saved/api/v1/bookmarks/search"))
            .and(query_param("searchMode","hybrid")).and(query_param("sortOrder","relevance"))
            .and(query_param("includeContent","false")).and(query_param("q","Karakeep Docker"))
            .and(header("Authorization","Bearer secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"bookmarks":[{"id":"abc","content":{"type":"text"}}],"nextCursor":null}))).expect(1).mount(&server).await;
        let service =
            KarakeepService::new(&format!("{}/saved/", server.uri()), "secret".into()).unwrap();
        let result = service
            .search(
                "Karakeep Docker",
                SearchMode::Hybrid,
                20,
                None,
                &CancellationSignal::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            service.reference(&result.bookmarks[0]).verification,
            "metadata"
        );
    }
    #[tokio::test]
    async fn blocks_redirects_without_sending_credentials_and_distinguishes_auth() {
        let server = MockServer::start().await;
        let target = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", target.uri()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&target)
            .await;
        let s = KarakeepService::new(&server.uri(), "secret".into()).unwrap();
        assert!(s
            .search(
                "x",
                SearchMode::Hybrid,
                20,
                None,
                &CancellationSignal::new()
            )
            .await
            .unwrap_err()
            .starts_with("KARAKEEP_REDIRECT"));
    }
}
