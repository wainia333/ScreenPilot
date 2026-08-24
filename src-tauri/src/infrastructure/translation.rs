use crate::application::state::CancellationSignal;
use crate::domain::providers::{exponential_backoff, retry_after};
use crate::infrastructure::provider_http::{
    client, read_json_response_limited, send_request, MAX_JSON_RESPONSE_BYTES,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::{Digest as Md5Digest, Md5};
use serde_json::{json, Value};
use sha2::Sha256;
use std::error::Error as StdError;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const GOOGLE_TRANSLATE_ENDPOINTS: &[GoogleEndpoint<'static>] = &[
    GoogleEndpoint::at("https://translate.google.com/translate_a/single"),
    GoogleEndpoint::gtx("https://translate.googleapis.com/translate_a/single"),
];
const GOOGLE_MAX_ATTEMPTS: u8 = 3;
const GOOGLE_CHUNK_MAX_CHARS: usize = 4_500;
const GOOGLE_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Copy)]
enum GoogleEndpointProfile {
    Gtx,
    At,
}

#[derive(Clone, Copy)]
struct GoogleEndpoint<'a> {
    url: &'a str,
    profile: GoogleEndpointProfile,
}

impl<'a> GoogleEndpoint<'a> {
    const fn gtx(url: &'a str) -> Self {
        Self {
            url,
            profile: GoogleEndpointProfile::Gtx,
        }
    }

    const fn at(url: &'a str) -> Self {
        Self {
            url,
            profile: GoogleEndpointProfile::At,
        }
    }
}

struct GoogleEndpointFailure {
    endpoint: String,
    reason: String,
}

struct GoogleRequestFailure {
    category: &'static str,
    display: String,
}

enum GoogleRequestError {
    Cancelled,
    Failed(GoogleRequestFailure),
}

#[allow(dead_code)]
pub async fn translate(
    method: &str,
    text: &str,
    target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    translate_with_source(method, text, "auto", target_language, credentials).await
}

pub async fn translate_with_source(
    method: &str,
    text: &str,
    requested_source_language: &str,
    requested_target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    translate_with_source_cancelled(
        method,
        text,
        requested_source_language,
        requested_target_language,
        credentials,
        None,
    )
    .await
}

pub async fn translate_with_source_cancelled(
    method: &str,
    text: &str,
    requested_source_language: &str,
    requested_target_language: &str,
    credentials: &[String],
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let source_language = resolve_source_language(text, requested_source_language);
    let target_language =
        resolve_target_language_for_source(text, requested_target_language, source_language);
    match method {
        "google" => google(text, source_language, target_language, cancellation).await,
        "bing" | "bing2" | "microsoft" => {
            microsoft_edge(text, source_language, target_language, cancellation).await
        }
        "yandex" => yandex(text, source_language, target_language, cancellation).await,
        "baidu" => {
            baidu(
                text,
                source_language,
                target_language,
                credentials,
                cancellation,
            )
            .await
        }
        "tencent" => {
            tencent(
                text,
                source_language,
                target_language,
                credentials,
                cancellation,
            )
            .await
        }
        "caiyun2" => {
            caiyun(
                text,
                source_language,
                target_language,
                credentials,
                cancellation,
            )
            .await
        }
        _ => Err("The selected translation method is not supported".into()),
    }
}

pub fn resolve_source_language<'a>(text: &str, requested: &'a str) -> &'a str {
    if requested != "auto" {
        return requested;
    }
    if text.trim().is_empty() {
        return "auto";
    }
    if text.chars().any(is_japanese_kana) {
        "ja"
    } else if text.chars().any(is_hangul_character) {
        "ko"
    } else if text.chars().any(is_chinese_character) {
        "zh-CN"
    } else if text
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        && text
            .chars()
            .filter(|character| character.is_alphabetic())
            .all(|character| character.is_ascii())
    {
        "en"
    } else {
        "auto"
    }
}

pub fn resolve_target_language_for_source<'a>(
    text: &str,
    requested: &'a str,
    source_language: &str,
) -> &'a str {
    if requested != "auto" {
        return requested;
    }
    match source_language {
        "zh-CN" => "en",
        "en" | "ja" | "ko" => "zh-CN",
        _ => resolve_target_language(text, requested),
    }
}

pub fn resolve_target_language<'a>(text: &str, requested: &'a str) -> &'a str {
    if requested != "auto" {
        return requested;
    }
    match resolve_source_language(text, "auto") {
        "zh-CN" => "en",
        _ => "zh-CN",
    }
}

fn is_japanese_kana(character: char) -> bool {
    matches!(
        character,
        '\u{3041}'..='\u{3096}'
            | '\u{309D}'..='\u{309F}'
            | '\u{30A1}'..='\u{30FA}'
            | '\u{30FD}'..='\u{30FF}'
            | '\u{31F0}'..='\u{31FF}'
            | '\u{FF66}'..='\u{FF9F}'
            | '\u{1B000}'..='\u{1B16F}'
    )
}

fn is_hangul_character(character: char) -> bool {
    matches!(
        character,
        '\u{1100}'..='\u{11FF}'
            | '\u{3130}'..='\u{318F}'
            | '\u{A960}'..='\u{A97F}'
            | '\u{AC00}'..='\u{D7AF}'
            | '\u{D7B0}'..='\u{D7FF}'
    )
}

fn is_chinese_character(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{20000}'..='\u{2FA1F}'
    )
}

async fn baidu(
    text: &str,
    source_language: &str,
    target_language: &str,
    credentials: &[String],
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let [app_id, secret, ..] = credentials else {
        return Err("Baidu translation App ID and secret are required".into());
    };
    let salt = Uuid::new_v4().simple().to_string();
    let sign = format!("{:x}", Md5::digest(format!("{app_id}{text}{salt}{secret}")));
    let response = send_request(
        client()?
            .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
            .form(&[
                ("q", text),
                ("from", provider_language(source_language)),
                ("to", provider_language(target_language)),
                ("appid", app_id),
                ("salt", &salt),
                ("sign", &sign),
            ]),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Baidu translation response",
        cancellation,
    )
    .await?;
    if let Some(error) = value.get("error_msg").and_then(Value::as_str) {
        return Err(format!("Baidu translation failed: {error}"));
    }
    let result = value
        .get("trans_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("dst").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    non_empty(result)
}

async fn tencent(
    text: &str,
    source_language: &str,
    target_language: &str,
    credentials: &[String],
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let [secret_id, secret_key, ..] = credentials else {
        return Err("Tencent translation Secret ID and Secret Key are required".into());
    };
    let timestamp = Utc::now().timestamp();
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let payload = serde_json::to_string(&json!({
        "SourceText": text,
        "Source": provider_language(source_language),
        "Target": provider_language(target_language),
        "ProjectId": 0
    }))
    .map_err(|error| error.to_string())?;
    let canonical_headers = "content-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\nx-tc-action:texttranslate\n";
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{}",
        sha256_hex(payload.as_bytes())
    );
    let scope = format!("{date}/tmt/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes())?;
    let secret_service = hmac_sha256(&secret_date, b"tmt")?;
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request")?;
    let signature = hex_bytes(&hmac_sha256(&secret_signing, string_to_sign.as_bytes())?);
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    let response = send_request(
        client()?
            .post("https://tmt.tencentcloudapi.com")
            .header("content-type", "application/json; charset=utf-8")
            .header("host", "tmt.tencentcloudapi.com")
            .header("x-tc-action", "TextTranslate")
            .header("x-tc-version", "2018-03-21")
            .header("x-tc-region", "ap-guangzhou")
            .header("x-tc-timestamp", timestamp)
            .header("authorization", authorization)
            .body(payload),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Tencent translation response",
        cancellation,
    )
    .await?;
    if let Some(error) = value
        .pointer("/Response/Error/Message")
        .and_then(Value::as_str)
    {
        return Err(format!("Tencent translation failed: {error}"));
    }
    non_empty(
        value
            .pointer("/Response/TargetText")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

async fn caiyun(
    text: &str,
    source_language: &str,
    target_language: &str,
    credentials: &[String],
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let Some(token) = credentials.first().filter(|value| !value.trim().is_empty()) else {
        return Err("Caiyun translation token is required".into());
    };
    let response = send_request(
        client()?
        .post("https://api.interpreter.caiyunai.com/v1/translator")
        .header("x-authorization", format!("token {token}"))
        .json(&json!({
            "source": [text],
            "trans_type": format!("{}2{}", provider_language(source_language), provider_language(target_language)),
            "request_id": Uuid::new_v4().to_string(),
            "detect": true,
            "media": "text"
        })),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Caiyun translation response",
        cancellation,
    )
    .await?;
    let result = match value.get("target") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    non_empty(result)
}

async fn google(
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    google_at_endpoints(
        GOOGLE_TRANSLATE_ENDPOINTS,
        text,
        source_language,
        target_language,
        cancellation,
    )
    .await
}

#[cfg(test)]
async fn google_at(
    endpoint: &str,
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let endpoints = [GoogleEndpoint::gtx(endpoint)];
    google_at_endpoints(
        &endpoints,
        text,
        source_language,
        target_language,
        cancellation,
    )
    .await
}

async fn google_at_endpoints(
    endpoints: &[GoogleEndpoint<'_>],
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    if endpoints.is_empty() {
        return Err("Google translation has no configured endpoints".into());
    }

    let mut translated = String::new();
    let mut preferred_endpoint = 0;
    for chunk in split_google_text(text, GOOGLE_CHUNK_MAX_CHARS) {
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        let (translated_chunk, successful_endpoint) = google_chunk_at_endpoints(
            endpoints,
            preferred_endpoint,
            chunk,
            source_language,
            target_language,
            cancellation,
        )
        .await?;
        translated.push_str(&translated_chunk);
        preferred_endpoint = successful_endpoint;
    }
    non_empty(translated)
}

async fn google_chunk_at_endpoints(
    endpoints: &[GoogleEndpoint<'_>],
    preferred_endpoint: usize,
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<(String, usize), String> {
    let max_attempts = usize::from(GOOGLE_MAX_ATTEMPTS).max(endpoints.len());
    let preferred_endpoint = preferred_endpoint % endpoints.len();
    let mut failures = Vec::new();
    let mut last_error = "Google translation request failed".to_string();

    for attempt in 0..max_attempts {
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }

        let endpoint_index = (preferred_endpoint + attempt) % endpoints.len();
        let endpoint = &endpoints[endpoint_index];
        let request = google_request(endpoint, text, source_language, target_language)?;
        let response = match send_google_request(request, cancellation).await {
            Ok(response) => response,
            Err(GoogleRequestError::Cancelled) => return Err("Request cancelled".into()),
            Err(GoogleRequestError::Failed(error)) => {
                last_error = format!("Google translation request failed: {}", error.display);
                record_google_failure(&mut failures, endpoint, error.category);
                if attempt + 1 >= max_attempts {
                    return Err(google_failures_error(endpoints, &failures, &last_error));
                }
                wait_for_google_failover(
                    exponential_backoff(u8::try_from(attempt).unwrap_or(u8::MAX)),
                    attempt,
                    endpoints.len(),
                    cancellation,
                )
                .await?;
                continue;
            }
        };

        let status = response.status();
        let retry_delay = retry_after(
            response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok()),
        )
        .unwrap_or_else(|| exponential_backoff(u8::try_from(attempt).unwrap_or(u8::MAX)));
        let value = read_json_response_limited::<Value>(
            response,
            MAX_JSON_RESPONSE_BYTES,
            "Google translation response",
            cancellation,
        )
        .await;

        if status.is_success() {
            match value {
                Ok(value) => match parse_google_translation(&value) {
                    Ok(translated) => return Ok((translated, endpoint_index)),
                    Err(error) => {
                        // Preserve the historical single-endpoint contract: a
                        // decoded but unknown shape is a terminal provider
                        // response. With independent fallbacks, however, let
                        // another endpoint handle it.
                        if endpoints.len() == 1 {
                            return Err(error);
                        }
                        last_error = error;
                        record_google_failure(&mut failures, endpoint, "empty response");
                        if attempt + 1 >= max_attempts {
                            return Err(google_failures_error(endpoints, &failures, &last_error));
                        }
                        wait_for_google_failover(
                            retry_delay,
                            attempt,
                            endpoints.len(),
                            cancellation,
                        )
                        .await?;
                        continue;
                    }
                },
                Err(error) => {
                    if cancellation.is_some_and(CancellationSignal::is_cancelled)
                        || error == "Request cancelled"
                    {
                        return Err("Request cancelled".into());
                    }
                    last_error = error;
                    record_google_failure(&mut failures, endpoint, "invalid response");
                    if attempt + 1 >= max_attempts {
                        return Err(google_failures_error(endpoints, &failures, &last_error));
                    }
                    wait_for_google_failover(retry_delay, attempt, endpoints.len(), cancellation)
                        .await?;
                    continue;
                }
            }
        }
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        last_error = value
            .expect_err("non-success Google responses are rejected by the bounded JSON reader");
        if !google_status_is_retriable(status.as_u16()) {
            return Err(last_error);
        }
        record_google_failure(
            &mut failures,
            endpoint,
            &format!("HTTP {}", status.as_u16()),
        );
        if attempt + 1 >= max_attempts {
            return Err(google_failures_error(endpoints, &failures, &last_error));
        }
        wait_for_google_failover(retry_delay, attempt, endpoints.len(), cancellation).await?;
    }

    Err(google_failures_error(endpoints, &failures, &last_error))
}

fn google_request(
    endpoint: &GoogleEndpoint<'_>,
    text: &str,
    source_language: &str,
    target_language: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let http_client =
        client().map_err(|_| "Google translation HTTP client initialization failed".to_string())?;
    let language_form = [
        ("sl", google_language_code(source_language)),
        ("tl", google_language_code(target_language)),
        ("source", "input"),
        ("q", text),
    ];
    let request = match endpoint.profile {
        GoogleEndpointProfile::At => http_client
            .post(endpoint.url)
            .query(&[("client", "at"), ("dt", "t"), ("dt", "rm"), ("dj", "1")])
            .form(&language_form),
        GoogleEndpointProfile::Gtx => http_client.post(endpoint.url).form(&[
            ("client", "gtx"),
            ("sl", google_language_code(source_language)),
            ("tl", google_language_code(target_language)),
            ("dt", "t"),
            ("dj", "1"),
            ("source", "input"),
            ("q", text),
        ]),
    };
    Ok(request.timeout(GOOGLE_REQUEST_TIMEOUT))
}

async fn send_google_request(
    request: reqwest::RequestBuilder,
    cancellation: Option<&CancellationSignal>,
) -> Result<reqwest::Response, GoogleRequestError> {
    if let Some(signal) = cancellation {
        if signal.is_cancelled() {
            return Err(GoogleRequestError::Cancelled);
        }
        tokio::select! {
            response = request.send() => response
                .map_err(|error| GoogleRequestError::Failed(google_request_failure(error))),
            _ = signal.cancelled() => Err(GoogleRequestError::Cancelled),
        }
    } else {
        request
            .send()
            .await
            .map_err(|error| GoogleRequestError::Failed(google_request_failure(error)))
    }
}

fn google_request_failure(error: reqwest::Error) -> GoogleRequestFailure {
    let category = classify_google_request_error(&error);
    GoogleRequestFailure {
        category,
        display: error.to_string(),
    }
}

fn classify_google_request_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "timeout";
    }

    let mut source_text = String::new();
    let mut source = error.source();
    while let Some(current) = source {
        if !source_text.is_empty() {
            source_text.push(' ');
        }
        source_text.push_str(&current.to_string().to_ascii_lowercase());
        source = current.source();
    }
    if [
        "dns",
        "resolve",
        "lookup address",
        "name or service",
        "no such host",
        "nodename",
    ]
    .iter()
    .any(|needle| source_text.contains(needle))
    {
        "DNS"
    } else if ["proxy", "tunnel"]
        .iter()
        .any(|needle| source_text.contains(needle))
    {
        "proxy"
    } else if ["tls", "ssl", "certificate", "handshake"]
        .iter()
        .any(|needle| source_text.contains(needle))
    {
        "TLS"
    } else if error.is_connect() {
        "connection"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_builder() {
        "request"
    } else if error.is_body() {
        "response body"
    } else {
        "network"
    }
}

fn record_google_failure(
    failures: &mut Vec<GoogleEndpointFailure>,
    endpoint: &GoogleEndpoint<'_>,
    reason: &str,
) {
    let endpoint = google_endpoint_label(endpoint.url);
    if let Some(existing) = failures
        .iter_mut()
        .find(|failure| failure.endpoint == endpoint)
    {
        existing.reason = reason.to_string();
    } else {
        failures.push(GoogleEndpointFailure {
            endpoint,
            reason: reason.to_string(),
        });
    }
}

fn google_endpoint_label(endpoint: &str) -> String {
    let Ok(url) = Url::parse(endpoint) else {
        return "invalid endpoint".into();
    };
    let Some(host) = url.host_str() else {
        return "invalid endpoint".into();
    };
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

fn google_failures_error(
    endpoints: &[GoogleEndpoint<'_>],
    failures: &[GoogleEndpointFailure],
    last_error: &str,
) -> String {
    if endpoints.len() == 1 {
        return last_error.to_string();
    }
    if failures.is_empty() {
        return "Google translation request failed".into();
    }
    let attempts = failures
        .iter()
        .map(|failure| format!("{} ({})", failure.endpoint, failure.reason))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Google translation request failed after trying {attempts}")
}

async fn wait_for_google_failover(
    delay: Duration,
    attempt: usize,
    endpoint_count: usize,
    cancellation: Option<&CancellationSignal>,
) -> Result<(), String> {
    // Try each independent endpoint once before backing off. A rate limit or
    // routing failure on one host should not delay a healthy fallback.
    if endpoint_count > 1 && attempt + 1 < endpoint_count {
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        return Ok(());
    }
    wait_for_google_retry(delay, cancellation).await
}

fn split_google_text(text: &str, max_chars: usize) -> Vec<&str> {
    assert!(
        max_chars > 0,
        "Google translation chunk size must be positive"
    );
    if text.is_empty() {
        return vec![text];
    }

    let mut chunks = Vec::new();
    let mut chunk_start = 0;
    while chunk_start < text.len() {
        let mut hard_cut = chunk_start;
        let mut paragraph_cut = None;
        let mut newline_cut = None;
        let mut sentence_cut = None;
        let mut whitespace_cut = None;

        for (char_index, (relative_byte, character)) in
            text[chunk_start..].char_indices().enumerate()
        {
            if char_index == max_chars {
                break;
            }
            let cut = chunk_start + relative_byte + character.len_utf8();
            hard_cut = cut;
            let remaining = &text[cut..];

            if character == '\n'
                && (text[chunk_start..cut].ends_with("\n\n")
                    || text[chunk_start..cut].ends_with("\r\n\r\n"))
            {
                paragraph_cut = Some(cut);
            }
            if character == '\n' || (character == '\r' && !remaining.starts_with('\n')) {
                newline_cut = Some(cut);
            }
            if is_google_sentence_ending(character) {
                sentence_cut = Some(cut);
            }
            // Keep CRLF together when a natural boundary is available; a hard
            // cut may still split it without losing either scalar value.
            if character.is_whitespace() && !(character == '\r' && remaining.starts_with('\n')) {
                whitespace_cut = Some(cut);
            }
        }

        if hard_cut == text.len() {
            chunks.push(&text[chunk_start..]);
            break;
        }
        let cut = paragraph_cut
            .or(newline_cut)
            .or(sentence_cut)
            .or(whitespace_cut)
            .unwrap_or(hard_cut);
        chunks.push(&text[chunk_start..cut]);
        chunk_start = cut;
    }
    chunks
}

fn is_google_sentence_ending(character: char) -> bool {
    matches!(
        character,
        '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；' | '｡' | '．'
    )
}

fn parse_google_translation(value: &Value) -> Result<String, String> {
    let structured_json_result = value
        .get("sentences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sentence| sentence.get("trans").and_then(Value::as_str))
        .collect::<String>();
    if !structured_json_result.trim().is_empty() {
        return Ok(structured_json_result);
    }

    // Older variants of the web endpoint return the translated segments as
    // the first string of every entry in the first top-level array.
    let legacy_array_result = value
        .as_array()
        .and_then(|root| root.first())
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|segment| {
            segment
                .as_array()
                .and_then(|fields| fields.first())
                .and_then(Value::as_str)
        })
        .collect::<String>();
    non_empty(legacy_array_result)
}

fn google_status_is_retriable(status: u16) -> bool {
    // A 403 from an undocumented Google web endpoint is frequently specific
    // to that host/client profile, so another independently shaped endpoint
    // can still succeed. Other ordinary 4xx responses are request errors.
    matches!(status, 403 | 408 | 429 | 500..=599)
}

async fn wait_for_google_retry(
    delay: Duration,
    cancellation: Option<&CancellationSignal>,
) -> Result<(), String> {
    if delay.is_zero() {
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        return Ok(());
    }
    if let Some(signal) = cancellation {
        tokio::select! {
            _ = tokio::time::sleep(delay) => Ok(()),
            _ = signal.cancelled() => Err("Request cancelled".into()),
        }
    } else {
        tokio::time::sleep(delay).await;
        Ok(())
    }
}

async fn microsoft_edge(
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    microsoft_edge_at(
        "https://edge.microsoft.com/translate/translatetext",
        text,
        source_language,
        target_language,
        cancellation,
    )
    .await
}

async fn microsoft_edge_at(
    endpoint: &str,
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let response = send_request(
        client()?
            .post(endpoint)
            .query(&microsoft_translation_query(
                source_language,
                target_language,
            ))
            .json(&json!([text])),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Microsoft translation response",
        cancellation,
    )
    .await?;
    let result = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.pointer("/translations/0/text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    non_empty(result)
}

async fn yandex(
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let language_pair = yandex_language_pair(source_language, target_language);
    let response = send_request(
        client()?
            .post("https://translate.yandex.net/api/v1/tr.json/translate")
            .query(&[("srv", "android"), ("format", "text")])
            .form(&[("text", text), ("lang", language_pair.as_str())]),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Yandex translation response",
        cancellation,
    )
    .await?;
    let result = value
        .get("text")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    non_empty(result)
}

fn language_code(value: &str) -> &str {
    match value {
        "auto" => "auto",
        "zh" | "zh-CN" => "zh-Hans",
        "zh-TW" | "zh-Hant" => "zh-Hant",
        value => value,
    }
}

fn google_language_code(value: &str) -> &str {
    match value {
        "auto" => "auto",
        "zh" | "zh-CN" | "zh-Hans" => "zh-CN",
        "zh-TW" | "zh-Hant" => "zh-TW",
        value => value,
    }
}

fn microsoft_translation_query<'a>(
    source_language: &'a str,
    target_language: &'a str,
) -> Vec<(&'static str, &'a str)> {
    vec![
        (
            "from",
            if source_language == "auto" {
                ""
            } else {
                language_code(source_language)
            },
        ),
        ("to", language_code(target_language)),
        ("isEnterpriseClient", "false"),
    ]
}

fn yandex_language_pair(source_language: &str, target_language: &str) -> String {
    if source_language == "auto" {
        return yandex_language_code(target_language).into();
    }
    format!(
        "{}-{}",
        yandex_language_code(source_language),
        yandex_language_code(target_language)
    )
}

fn yandex_language_code(value: &str) -> &str {
    match value {
        "auto" => "auto",
        "zh" | "zh-CN" | "zh-Hans" => "zh",
        "zh-TW" | "zh-Hant" => "zh-Hant",
        value => value,
    }
}

fn provider_language(value: &str) -> &str {
    match value {
        "auto" => "auto",
        "zh" | "zh-CN" | "zh-Hans" => "zh",
        "zh-TW" | "zh-Hant" => "cht",
        value => value,
    }
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn hmac_sha256(key: &[u8], value: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn non_empty(value: String) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("Translation service returned an empty response".into())
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        google_at, google_at_endpoints, google_language_code, google_status_is_retriable,
        microsoft_edge_at, microsoft_translation_query, parse_google_translation,
        provider_language, resolve_source_language, resolve_target_language,
        resolve_target_language_for_source, split_google_text, translate_with_source_cancelled,
        yandex_language_pair, GoogleEndpoint, GOOGLE_CHUNK_MAX_CHARS,
    };
    use crate::application::state::CancellationSignal;
    use serde_json::json;
    use std::io::{Error as IoError, ErrorKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn automatic_target_translates_chinese_to_english_and_other_text_to_chinese() {
        assert_eq!(resolve_target_language("你好，ScreenPilot", "auto"), "en");
        assert_eq!(
            resolve_target_language("Hello, ScreenPilot", "auto"),
            "zh-CN"
        );
        assert_eq!(resolve_target_language("12345", "auto"), "zh-CN");
        assert_eq!(resolve_target_language("你好", "ja"), "ja");
    }

    #[test]
    fn automatic_source_identifies_supported_scripts() {
        assert_eq!(resolve_source_language("Hello, ScreenPilot!", "auto"), "en");
        assert_eq!(
            resolve_source_language("你好，ScreenPilot", "auto"),
            "zh-CN"
        );
        assert_eq!(resolve_source_language("こんにちは", "auto"), "ja");
        assert_eq!(resolve_source_language("今日は良い天気です", "auto"), "ja");
        assert_eq!(resolve_source_language("日本語を翻訳する", "auto"), "ja");
        assert_eq!(resolve_source_language("한국어를 번역합니다", "auto"), "ko");
        assert_eq!(resolve_source_language("中文・测试", "auto"), "zh-CN");
        assert_eq!(resolve_source_language("12345", "auto"), "auto");
        assert_eq!(resolve_source_language("", "auto"), "auto");
        assert_eq!(resolve_source_language("hello", "ja"), "ja");
    }

    #[test]
    fn automatic_target_follows_effective_source_for_english_and_chinese() {
        assert_eq!(
            resolve_target_language_for_source("Hello", "auto", "en"),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language_for_source("你好", "auto", "zh-CN"),
            "en"
        );
        assert_eq!(
            resolve_target_language_for_source("こんにちは", "auto", "auto"),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language_for_source("Hello", "ja", "en"),
            "ja"
        );
        assert_eq!(
            resolve_target_language_for_source("日本語", "auto", "ja"),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language_for_source("한국어", "auto", "ko"),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language("今日は良い天気です", "auto"),
            "zh-CN"
        );
        assert_eq!(resolve_target_language("한국어", "auto"), "zh-CN");
    }

    #[test]
    fn provider_language_contract_preserves_explicit_source() {
        assert_eq!(provider_language("en"), "en");
        assert_eq!(provider_language("zh-CN"), "zh");
        assert_eq!(provider_language("auto"), "auto");
        assert_eq!(yandex_language_pair("en", "zh-CN"), "en-zh");
        assert_eq!(yandex_language_pair("auto", "zh-CN"), "zh");
    }

    #[test]
    fn google_uses_its_own_simplified_and_traditional_chinese_codes() {
        assert_eq!(google_language_code("auto"), "auto");
        assert_eq!(google_language_code("zh"), "zh-CN");
        assert_eq!(google_language_code("zh-CN"), "zh-CN");
        assert_eq!(google_language_code("zh-Hans"), "zh-CN");
        assert_eq!(google_language_code("zh-TW"), "zh-TW");
        assert_eq!(google_language_code("zh-Hant"), "zh-TW");
        assert_eq!(google_language_code("en"), "en");
    }

    #[test]
    fn google_parses_structured_and_legacy_array_responses() {
        assert_eq!(
            parse_google_translation(&json!({
                "sentences": [
                    {"trans": "你好，"},
                    {"trans": "世界"}
                ]
            }))
            .expect("structured Google response"),
            "你好，世界"
        );
        assert_eq!(
            parse_google_translation(&json!([
                [
                    ["你好，", "Hello,", null, null, 10],
                    ["世界", "world", null, null, 10]
                ],
                null,
                "en"
            ]))
            .expect("legacy Google response"),
            "你好，世界"
        );
    }

    #[test]
    fn google_retries_only_transient_http_statuses() {
        assert!(google_status_is_retriable(403));
        assert!(google_status_is_retriable(408));
        assert!(google_status_is_retriable(429));
        assert!(google_status_is_retriable(500));
        assert!(google_status_is_retriable(599));
        assert!(!google_status_is_retriable(400));
        assert!(!google_status_is_retriable(401));
        assert!(!google_status_is_retriable(404));
    }

    #[test]
    fn google_chunking_preserves_multibyte_text_and_never_exceeds_the_scalar_limit() {
        let text = "你".repeat(GOOGLE_CHUNK_MAX_CHARS * 2 + 1);
        let chunks = split_google_text(&text, GOOGLE_CHUNK_MAX_CHARS);

        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.chars().count())
                .collect::<Vec<_>>(),
            [GOOGLE_CHUNK_MAX_CHARS, GOOGLE_CHUNK_MAX_CHARS, 1]
        );
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= GOOGLE_CHUNK_MAX_CHARS));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn google_chunking_prefers_paragraph_newline_sentence_and_whitespace_boundaries() {
        let text = "甲乙\n\n丙丁\n戊己。庚辛 壬癸子丑";
        let chunks = split_google_text(text, 10);

        assert_eq!(chunks[0], "甲乙\n\n");
        assert_eq!(chunks[1], "丙丁\n");
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 10));
    }

    #[test]
    fn google_chunking_hard_splits_a_long_string_only_at_utf8_boundaries() {
        let text = "😀é中".repeat(11);
        let chunks = split_google_text(&text, 5);

        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 5));
        assert!(chunks[..chunks.len() - 1]
            .iter()
            .all(|chunk| chunk.chars().count() == 5));
    }

    #[tokio::test]
    async fn google_posts_long_text_as_a_form_without_a_query_string() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .and(header("content-type", "application/x-www-form-urlencoded"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sentences": [{"trans": "translated"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let text = "A".repeat(GOOGLE_CHUNK_MAX_CHARS);

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                &text,
                "zh-Hant",
                "zh-CN",
                None,
            )
            .await
            .expect("Google translation"),
            "translated"
        );

        let requests = server
            .received_requests()
            .await
            .expect("recorded Google request");
        assert_eq!(requests.len(), 1);
        assert!(requests[0].url.query().is_none());
        let body = String::from_utf8(requests[0].body.clone()).expect("URL-encoded form body");
        assert!(body.contains("sl=zh-TW"));
        assert!(body.contains("tl=zh-CN"));
        assert!(body.contains(&format!("q={text}")));
    }

    #[tokio::test]
    async fn google_translates_multiple_chunks_sequentially_and_concatenates_in_order() {
        let server = MockServer::start().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let responder_attempts = Arc::clone(&attempts);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                let translated = match responder_attempts.fetch_add(1, Ordering::SeqCst) {
                    0 => "第一块",
                    1 => "第二块",
                    2 => "第三块",
                    attempt => panic!("unexpected Google chunk request {attempt}"),
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "sentences": [{"trans": translated}]
                }))
            })
            .expect(3)
            .mount(&server)
            .await;
        let text = "A".repeat(GOOGLE_CHUNK_MAX_CHARS * 2 + 1);

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                &text,
                "en",
                "zh-CN",
                None,
            )
            .await
            .expect("chunked Google translation"),
            "第一块第二块第三块"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn google_retries_a_rate_limit_and_honors_retry_after() {
        let server = MockServer::start().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let responder_attempts = Arc::clone(&attempts);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                if responder_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(429).insert_header("retry-after", "0")
                } else {
                    ResponseTemplate::new(200).set_body_json(json!({
                        "sentences": [{"trans": "成功"}]
                    }))
                }
            })
            .expect(2)
            .mount(&server)
            .await;

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                "hello",
                "en",
                "zh-CN",
                None,
            )
            .await
            .expect("retried Google translation"),
            "成功"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn google_retries_a_malformed_success_body_then_accepts_valid_json() {
        let server = MockServer::start().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let responder_attempts = Arc::clone(&attempts);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                if responder_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(200)
                        .insert_header("retry-after", "0")
                        .set_body_string("{malformed-json")
                } else {
                    ResponseTemplate::new(200).set_body_json(json!({
                        "sentences": [{"trans": "恢复成功"}]
                    }))
                }
            })
            .expect(2)
            .mount(&server)
            .await;

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                "hello",
                "en",
                "zh-CN",
                None,
            )
            .await
            .expect("Google translation after malformed response retry"),
            "恢复成功"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn google_does_not_retry_a_decoded_but_unknown_success_shape() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "unexpected": "shape"
            })))
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                "hello",
                "en",
                "zh-CN",
                None,
            )
            .await,
            Err("Translation service returned an empty response".into())
        );
    }

    #[tokio::test]
    async fn google_retries_a_transient_connection_failure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with_err(|_: &wiremock::Request| {
                IoError::new(ErrorKind::ConnectionReset, "temporary connection reset")
            })
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sentences": [{"trans": "已恢复"}]
            })))
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                "hello",
                "en",
                "zh-CN",
                None,
            )
            .await
            .expect("Google translation after connection retry"),
            "已恢复"
        );
    }

    #[tokio::test]
    async fn google_falls_back_after_a_primary_connection_failure() {
        let primary = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with_err(|_: &wiremock::Request| {
                IoError::new(ErrorKind::ConnectionReset, "primary connection reset")
            })
            .expect(1)
            .mount(&primary)
            .await;
        let fallback = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .and(query_param("client", "at"))
            .and(query_param("dj", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sentences": [{"trans": "备用成功"}]
            })))
            .expect(1)
            .mount(&fallback)
            .await;
        let primary_endpoint = format!("{}/translate_a/single", primary.uri());
        let fallback_endpoint = format!("{}/translate_a/single", fallback.uri());
        let endpoints = [
            GoogleEndpoint::gtx(&primary_endpoint),
            GoogleEndpoint::at(&fallback_endpoint),
        ];

        assert_eq!(
            google_at_endpoints(&endpoints, "hello", "en", "zh-CN", None)
                .await
                .expect("fallback Google translation"),
            "备用成功"
        );

        let requests = fallback
            .received_requests()
            .await
            .expect("recorded fallback request");
        let body = String::from_utf8(requests[0].body.clone()).expect("URL-encoded form body");
        assert!(body.contains("sl=en"));
        assert!(body.contains("tl=zh-CN"));
        assert!(body.contains("q=hello"));
    }

    #[tokio::test]
    async fn google_aggregates_endpoint_failures_without_leaking_source_text() {
        let primary = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(503).insert_header("retry-after", "0"))
            .expect(2)
            .mount(&primary)
            .await;
        let fallback = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(503).insert_header("retry-after", "0"))
            .expect(1)
            .mount(&fallback)
            .await;
        let primary_endpoint = format!("{}/translate_a/single", primary.uri());
        let fallback_endpoint = format!("{}/translate_a/single", fallback.uri());
        let endpoints = [
            GoogleEndpoint::gtx(&primary_endpoint),
            GoogleEndpoint::at(&fallback_endpoint),
        ];
        let secret = "DO-NOT-LEAK-THIS-SOURCE-TEXT";

        let error = google_at_endpoints(&endpoints, secret, "en", "zh-CN", None)
            .await
            .expect_err("all Google endpoints must fail");

        assert!(error.contains(primary.uri().trim_start_matches("http://")));
        assert!(error.contains(fallback.uri().trim_start_matches("http://")));
        assert!(error.contains("HTTP 503"));
        assert!(!error.contains(secret));
        assert!(!error.contains("q="));
    }

    #[tokio::test]
    async fn google_keeps_using_a_successful_fallback_for_later_chunks() {
        let primary = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&primary)
            .await;
        let fallback = MockServer::start().await;
        let fallback_attempts = Arc::new(AtomicUsize::new(0));
        let responder_attempts = Arc::clone(&fallback_attempts);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                let translated = match responder_attempts.fetch_add(1, Ordering::SeqCst) {
                    0 => "第一块",
                    1 => "第二块",
                    2 => "第三块",
                    attempt => panic!("unexpected fallback chunk request {attempt}"),
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "sentences": [{"trans": translated}]
                }))
            })
            .expect(3)
            .mount(&fallback)
            .await;
        let primary_endpoint = format!("{}/translate_a/single", primary.uri());
        let fallback_endpoint = format!("{}/translate_a/single", fallback.uri());
        let endpoints = [
            GoogleEndpoint::gtx(&primary_endpoint),
            GoogleEndpoint::at(&fallback_endpoint),
        ];
        let text = "A".repeat(GOOGLE_CHUNK_MAX_CHARS * 2 + 1);

        assert_eq!(
            google_at_endpoints(&endpoints, &text, "en", "zh-CN", None)
                .await
                .expect("sticky fallback Google translation"),
            "第一块第二块第三块"
        );
        assert_eq!(fallback_attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn cancelling_a_google_request_does_not_try_a_fallback() {
        let primary = MockServer::start().await;
        let first_request = Arc::new(Notify::new());
        let responder_notification = Arc::clone(&first_request);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                responder_notification.notify_one();
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(30))
                    .set_body_json(json!({"sentences": [{"trans": "too late"}]}))
            })
            .mount(&primary)
            .await;
        let fallback = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sentences": [{"trans": "must not run"}]
            })))
            .mount(&fallback)
            .await;
        let primary_endpoint = format!("{}/translate_a/single", primary.uri());
        let fallback_endpoint = format!("{}/translate_a/single", fallback.uri());
        let endpoints = [
            GoogleEndpoint::gtx(&primary_endpoint),
            GoogleEndpoint::at(&fallback_endpoint),
        ];
        let signal = CancellationSignal::new();

        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                google_at_endpoints(&endpoints, "hello", "en", "zh-CN", Some(&signal)),
                async {
                    first_request.notified().await;
                    signal.cancel();
                }
            )
        })
        .await
        .expect("cancellation must interrupt the primary endpoint");

        assert_eq!(result, Err("Request cancelled".into()));
        assert!(fallback
            .received_requests()
            .await
            .expect("recorded fallback requests")
            .is_empty());
    }

    #[tokio::test]
    async fn google_falls_back_from_an_empty_success_shape() {
        let primary = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "unexpected": "shape"
            })))
            .expect(1)
            .mount(&primary)
            .await;
        let fallback = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sentences": [{"trans": "结构恢复"}]
            })))
            .expect(1)
            .mount(&fallback)
            .await;
        let primary_endpoint = format!("{}/translate_a/single", primary.uri());
        let fallback_endpoint = format!("{}/translate_a/single", fallback.uri());
        let endpoints = [
            GoogleEndpoint::gtx(&primary_endpoint),
            GoogleEndpoint::at(&fallback_endpoint),
        ];

        assert_eq!(
            google_at_endpoints(&endpoints, "hello", "en", "zh-CN", None)
                .await
                .expect("Google translation after an empty response fallback"),
            "结构恢复"
        );
    }

    #[tokio::test]
    async fn google_does_not_retry_a_permanent_client_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            google_at(
                &format!("{}/translate_a/single", server.uri()),
                "hello",
                "en",
                "zh-CN",
                None,
            )
            .await,
            Err("Google translation response returned HTTP 400".into())
        );
    }

    #[tokio::test]
    async fn cancelling_google_translation_interrupts_retry_after_wait() {
        let server = MockServer::start().await;
        let first_request = Arc::new(Notify::new());
        let responder_notification = Arc::clone(&first_request);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                responder_notification.notify_one();
                ResponseTemplate::new(429).insert_header("retry-after", "30")
            })
            .mount(&server)
            .await;
        let signal = CancellationSignal::new();
        let endpoint = format!("{}/translate_a/single", server.uri());

        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                google_at(&endpoint, "hello", "en", "zh-CN", Some(&signal)),
                async {
                    first_request.notified().await;
                    signal.cancel();
                }
            )
        })
        .await
        .expect("cancellation must not wait for Retry-After");
        assert_eq!(result, Err("Request cancelled".into()));
    }

    #[tokio::test]
    async fn cancelling_google_translation_stops_during_a_later_chunk() {
        let server = MockServer::start().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let responder_attempts = Arc::clone(&attempts);
        let second_request = Arc::new(Notify::new());
        let responder_notification = Arc::clone(&second_request);
        Mock::given(method("POST"))
            .and(path("/translate_a/single"))
            .respond_with(move |_: &wiremock::Request| {
                if responder_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(200).set_body_json(json!({
                        "sentences": [{"trans": "first"}]
                    }))
                } else {
                    responder_notification.notify_one();
                    ResponseTemplate::new(200)
                        .set_delay(Duration::from_secs(30))
                        .set_body_json(json!({"sentences": [{"trans": "second"}]}))
                }
            })
            .mount(&server)
            .await;
        let signal = CancellationSignal::new();
        let endpoint = format!("{}/translate_a/single", server.uri());
        let text = "A".repeat(GOOGLE_CHUNK_MAX_CHARS + 1);

        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                google_at(&endpoint, &text, "en", "zh-CN", Some(&signal)),
                async {
                    second_request.notified().await;
                    signal.cancel();
                }
            )
        })
        .await
        .expect("cancellation must interrupt a later chunk request");
        assert_eq!(result, Err("Request cancelled".into()));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn microsoft_sends_empty_automatic_source_and_preserves_explicit_source() {
        let automatic = microsoft_translation_query("auto", "zh-CN");
        assert!(automatic.contains(&("from", "")));
        assert!(automatic.contains(&("to", "zh-Hans")));
        assert!(automatic.contains(&("isEnterpriseClient", "false")));
        let explicit = microsoft_translation_query("en", "zh-CN");
        assert!(explicit.contains(&("from", "en")));
        assert!(explicit.contains(&("to", "zh-Hans")));
    }

    #[tokio::test]
    async fn microsoft_uses_the_unauthenticated_edge_contract_and_joins_results() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/translate/translatetext"))
            .and(query_param("from", ""))
            .and(query_param("to", "zh-Hans"))
            .and(query_param("isEnterpriseClient", "false"))
            .and(header("content-type", "application/json"))
            .and(body_json(json!(["Hello world\nGood morning"])))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"translations": [{"text": "你好，世界", "to": "zh-Hans"}]},
                {"translations": [{"text": "早上好", "to": "zh-Hans"}]}
            ])))
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            microsoft_edge_at(
                &format!("{}/translate/translatetext", server.uri()),
                "Hello world\nGood morning",
                "auto",
                "zh-CN",
                None,
            )
            .await
            .expect("Microsoft translation"),
            "你好，世界\n早上好"
        );
        let requests = server
            .received_requests()
            .await
            .expect("recorded Microsoft request");
        assert_eq!(requests.len(), 1);
        assert!(requests[0].headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn cancelled_translation_returns_before_starting_remote_work() {
        let signal = CancellationSignal::new();
        signal.cancel();

        assert_eq!(
            translate_with_source_cancelled("google", "hello", "en", "zh-CN", &[], Some(&signal),)
                .await,
            Err("Request cancelled".into())
        );
    }
}
