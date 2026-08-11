use crate::application::state::CancellationSignal;
use crate::infrastructure::provider_http::{
    client, read_json_response_limited, read_text_response_limited, send_request,
    MAX_JSON_RESPONSE_BYTES, MAX_TEXT_RESPONSE_BYTES,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::{Digest as Md5Digest, Md5};
use serde_json::{json, Value};
use sha2::Sha256;
use uuid::Uuid;

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
    let target = language_code(target_language);
    let response = send_request(
        client()?
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[
                ("client", "gtx"),
                ("sl", language_code(source_language)),
                ("tl", target),
                ("dt", "t"),
                ("dj", "1"),
                ("source", "input"),
                ("q", text),
            ]),
        cancellation,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Google translation response",
        cancellation,
    )
    .await?;
    let result = value
        .get("sentences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sentence| sentence.get("trans").and_then(Value::as_str))
        .collect::<String>();
    non_empty(result)
}

async fn microsoft_edge(
    text: &str,
    source_language: &str,
    target_language: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let token_response = send_request(
        client()?.get("https://edge.microsoft.com/translate/auth"),
        cancellation,
    )
    .await?;
    let token = read_text_response_limited(
        token_response,
        MAX_TEXT_RESPONSE_BYTES,
        "Microsoft translation auth response",
        cancellation,
    )
    .await?;
    let response = send_request(
        client()?
            .post("https://api-edge.cognitive.microsofttranslator.com/translate")
            .query(&microsoft_translation_query(
                source_language,
                target_language,
            ))
            .bearer_auth(token.trim())
            .json(&json!([{"Text": text}])),
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
        .pointer("/0/translations/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
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

fn microsoft_translation_query<'a>(
    source_language: &'a str,
    target_language: &'a str,
) -> Vec<(&'static str, &'a str)> {
    let mut query = vec![
        ("api-version", "3.0"),
        ("to", language_code(target_language)),
        ("includeSentenceLength", "true"),
    ];
    if source_language != "auto" {
        query.push(("from", language_code(source_language)));
    }
    query
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
        microsoft_translation_query, provider_language, resolve_source_language,
        resolve_target_language, resolve_target_language_for_source,
        translate_with_source_cancelled, yandex_language_pair,
    };
    use crate::application::state::CancellationSignal;

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
    fn microsoft_omits_automatic_source_and_preserves_explicit_source() {
        let automatic = microsoft_translation_query("auto", "zh-CN");
        assert!(!automatic.iter().any(|(name, _)| *name == "from"));
        assert!(automatic.contains(&("to", "zh-Hans")));
        let explicit = microsoft_translation_query("en", "zh-CN");
        assert!(explicit.contains(&("from", "en")));
        assert!(explicit.contains(&("to", "zh-Hans")));
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
