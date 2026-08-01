use crate::infrastructure::provider_http::client;
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::{Digest as Md5Digest, Md5};
use serde_json::{json, Value};
use sha2::Sha256;
use uuid::Uuid;

pub async fn translate(
    method: &str,
    text: &str,
    target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    let target_language = resolve_target_language(text, target_language);
    match method {
        "google" => google(text, target_language).await,
        "bing" | "bing2" | "microsoft" => microsoft_edge(text, target_language).await,
        "yandex" => yandex(text, target_language).await,
        "baidu" => baidu(text, target_language, credentials).await,
        "tencent" => tencent(text, target_language, credentials).await,
        "caiyun2" => caiyun(text, target_language, credentials).await,
        _ => Err("The selected translation method is not supported".into()),
    }
}

pub fn resolve_target_language<'a>(text: &str, requested: &'a str) -> &'a str {
    if requested != "auto" {
        return requested;
    }
    if text.chars().any(is_chinese_character) {
        "en"
    } else {
        "zh-CN"
    }
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
    target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    let [app_id, secret, ..] = credentials else {
        return Err("Baidu translation App ID and secret are required".into());
    };
    let salt = Uuid::new_v4().simple().to_string();
    let sign = format!("{:x}", Md5::digest(format!("{app_id}{text}{salt}{secret}")));
    let value = client()?
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .form(&[
            ("q", text),
            ("from", "auto"),
            ("to", provider_language(target_language)),
            ("appid", app_id),
            ("salt", &salt),
            ("sign", &sign),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
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
    target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    let [secret_id, secret_key, ..] = credentials else {
        return Err("Tencent translation Secret ID and Secret Key are required".into());
    };
    let timestamp = Utc::now().timestamp();
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let payload = serde_json::to_string(&json!({
        "SourceText": text,
        "Source": "auto",
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
    let value = client()?
        .post("https://tmt.tencentcloudapi.com")
        .header("content-type", "application/json; charset=utf-8")
        .header("host", "tmt.tencentcloudapi.com")
        .header("x-tc-action", "TextTranslate")
        .header("x-tc-version", "2018-03-21")
        .header("x-tc-region", "ap-guangzhou")
        .header("x-tc-timestamp", timestamp)
        .header("authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
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
    target_language: &str,
    credentials: &[String],
) -> Result<String, String> {
    let Some(token) = credentials.first().filter(|value| !value.trim().is_empty()) else {
        return Err("Caiyun translation token is required".into());
    };
    let value = client()?
        .post("https://api.interpreter.caiyunai.com/v1/translator")
        .header("x-authorization", format!("token {token}"))
        .json(&json!({
            "source": [text],
            "trans_type": format!("auto2{}", provider_language(target_language)),
            "request_id": Uuid::new_v4().to_string(),
            "detect": true,
            "media": "text"
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
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

async fn google(text: &str, target_language: &str) -> Result<String, String> {
    let target = language_code(target_language);
    let value = client()?
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", target),
            ("dt", "t"),
            ("dj", "1"),
            ("source", "input"),
            ("q", text),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let result = value
        .get("sentences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sentence| sentence.get("trans").and_then(Value::as_str))
        .collect::<String>();
    non_empty(result)
}

async fn microsoft_edge(text: &str, target_language: &str) -> Result<String, String> {
    let token = client()?
        .get("https://edge.microsoft.com/translate/auth")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let value = client()?
        .post("https://api-edge.cognitive.microsofttranslator.com/translate")
        .query(&[
            ("api-version", "3.0"),
            ("to", language_code(target_language)),
            ("includeSentenceLength", "true"),
        ])
        .bearer_auth(token.trim())
        .json(&json!([{"Text": text}]))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let result = value
        .pointer("/0/translations/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    non_empty(result)
}

async fn yandex(text: &str, target_language: &str) -> Result<String, String> {
    let value = client()?
        .post("https://translate.yandex.net/api/v1/tr.json/translate")
        .query(&[("srv", "android"), ("format", "text")])
        .form(&[("text", text), ("lang", language_code(target_language))])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
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
        "auto" | "zh" | "zh-CN" => "zh-Hans",
        "zh-TW" | "zh-Hant" => "zh-Hant",
        value => value,
    }
}

fn provider_language(value: &str) -> &str {
    match value {
        "auto" | "zh" | "zh-CN" | "zh-Hans" => "zh",
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
    use super::resolve_target_language;

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
}
