use crate::infrastructure::provider_http::{
    client, read_json_response_limited, send_request, MAX_JSON_RESPONSE_BYTES,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use md5::{Digest, Md5};
use serde_json::{json, Value};
use std::borrow::Cow;

const CHAOXING_SECRET_ID_ENV: &str = "SCREENPILOT_CHAOXING_SECRET_ID";
const CHAOXING_SIGNING_SECRET_ENV: &str = "SCREENPILOT_CHAOXING_SIGNING_SECRET";
const DEFAULT_CHAOXING_SECRET_ID: &str = "Inner_40731a6efece4c2e992c0d670222e6da";
const DEFAULT_CHAOXING_SIGNING_SECRET: &str = "43e7a66431b14c8f856a8e889070c19b";
const MAX_CHAOXING_MATERIAL_LENGTH: usize = 512;

struct ChaoxingClientMaterial {
    secret_id: Cow<'static, str>,
    signing_secret: Cow<'static, str>,
}

pub async fn chaoxing(image: &[u8]) -> Result<String, String> {
    if image.len() > 5 * 1024 * 1024 {
        return Err("Chaoxing OCR accepts images up to 5MB".into());
    }
    let material = chaoxing_client_material()?;
    let timestamp = Utc::now().timestamp_millis();
    let body = json!({
        "images": [{"data": STANDARD.encode(image), "dataId": "1", "type": 2}],
        "nonce": timestamp.unsigned_abs() % 100_000,
        "secretId": material.secret_id.as_ref(),
        "timestamp": timestamp
    });
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let signature = format!(
        "{:x}",
        Md5::digest(format!("{body_text}{}", material.signing_secret.as_ref()))
    );
    let response = send_request(
        client()?
            .post("https://ai.chaoxing.com/api/v1/ocr/common/sync")
            .header("content-type", "application/json;charset=utf-8")
            .header("cx-signature", signature)
            .body(body_text),
        None,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Chaoxing OCR response",
        None,
    )
    .await?;
    let mut lines = Vec::new();
    collect_text(value.get("data").unwrap_or(&Value::Null), &mut lines);
    lines.dedup();
    if lines.is_empty() {
        Err(value
            .get("message")
            .or_else(|| value.get("msg"))
            .and_then(Value::as_str)
            .unwrap_or("Chaoxing OCR returned no visible text")
            .to_string())
    } else {
        Ok(lines.join("\n"))
    }
}

fn chaoxing_client_material() -> Result<ChaoxingClientMaterial, String> {
    chaoxing_client_material_with(|name| std::env::var(name).ok())
}

fn chaoxing_client_material_with<F>(mut lookup: F) -> Result<ChaoxingClientMaterial, String>
where
    F: FnMut(&str) -> Option<String>,
{
    match (
        lookup(CHAOXING_SECRET_ID_ENV),
        lookup(CHAOXING_SIGNING_SECRET_ENV),
    ) {
        (None, None) => Ok(ChaoxingClientMaterial {
            secret_id: Cow::Borrowed(DEFAULT_CHAOXING_SECRET_ID),
            signing_secret: Cow::Borrowed(DEFAULT_CHAOXING_SIGNING_SECRET),
        }),
        (Some(secret_id), Some(signing_secret)) => {
            validate_chaoxing_material(&secret_id)?;
            validate_chaoxing_material(&signing_secret)?;
            Ok(ChaoxingClientMaterial {
                secret_id: Cow::Owned(secret_id),
                signing_secret: Cow::Owned(signing_secret),
            })
        }
        _ => Err("Chaoxing OCR client material configuration is incomplete".into()),
    }
}

fn validate_chaoxing_material(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_CHAOXING_MATERIAL_LENGTH
        || value.chars().any(char::is_control)
    {
        Err("Chaoxing OCR client material configuration is invalid".into())
    } else {
        Ok(())
    }
}

pub async fn baidu(image: &[u8], credentials: &[String]) -> Result<String, String> {
    let [api_key, secret_key, ..] = credentials else {
        return Err("Baidu OCR API key and secret key are required".into());
    };
    let token_response = send_request(
        client()?
            .post("https://aip.baidubce.com/oauth/2.0/token")
            .query(&[
                ("grant_type", "client_credentials"),
                ("client_id", api_key),
                ("client_secret", secret_key),
            ]),
        None,
    )
    .await?;
    let token_value = read_json_response_limited::<Value>(
        token_response,
        MAX_JSON_RESPONSE_BYTES,
        "Baidu OCR authentication response",
        None,
    )
    .await?;
    let token = token_value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Baidu OCR authentication failed")?;
    let response = send_request(
        client()?
            .post("https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic")
            .query(&[("access_token", token)])
            .form(&[
                ("image", STANDARD.encode(image)),
                ("paragraph", "true".to_string()),
            ]),
        None,
    )
    .await?;
    let value = read_json_response_limited::<Value>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Baidu OCR response",
        None,
    )
    .await?;
    if let Some(error) = value.get("error_msg").and_then(Value::as_str) {
        return Err(format!("Baidu OCR failed: {error}"));
    }
    let lines = value
        .get("words_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("words").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        Err("Baidu OCR returned no visible text".into())
    } else {
        Ok(lines.join("\n"))
    }
}

fn collect_text(value: &Value, lines: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    lines.push(trimmed.to_string());
                }
            }
            object.values().for_each(|child| collect_text(child, lines));
        }
        Value::Array(items) => items.iter().for_each(|item| collect_text(item, lines)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_nested_visible_text() {
        let value = json!({"blocks": [{"text": "first"}, {"children": [{"text": "第二行"}]}]});
        let mut lines = Vec::new();
        collect_text(&value, &mut lines);
        assert_eq!(lines, ["first", "第二行"]);
    }

    #[test]
    fn chaoxing_material_defaults_preserve_the_existing_zero_configuration_path() {
        let material = chaoxing_client_material_with(|_| None).expect("default material");
        assert!(!material.secret_id.is_empty());
        assert!(!material.signing_secret.is_empty());
        assert!(matches!(material.secret_id, Cow::Borrowed(_)));
        assert!(matches!(material.signing_secret, Cow::Borrowed(_)));
    }

    #[test]
    fn chaoxing_material_supports_complete_runtime_rotation() {
        let material = chaoxing_client_material_with(|name| match name {
            CHAOXING_SECRET_ID_ENV => Some("deployment-id".into()),
            CHAOXING_SIGNING_SECRET_ENV => Some("deployment-signing-secret".into()),
            _ => None,
        })
        .expect("runtime material");

        assert_eq!(material.secret_id, "deployment-id");
        assert_eq!(material.signing_secret, "deployment-signing-secret");
    }

    #[test]
    fn chaoxing_material_rejects_partial_or_unsafe_overrides_without_echoing_them() {
        assert_eq!(
            chaoxing_client_material_with(|name| {
                (name == CHAOXING_SECRET_ID_ENV).then(|| "deployment-id".into())
            })
            .err()
            .as_deref(),
            Some("Chaoxing OCR client material configuration is incomplete")
        );
        let unsafe_value = "private\nmaterial";
        let error = chaoxing_client_material_with(|name| match name {
            CHAOXING_SECRET_ID_ENV => Some(unsafe_value.into()),
            CHAOXING_SIGNING_SECRET_ENV => Some("deployment-signing-secret".into()),
            _ => None,
        })
        .err()
        .expect("unsafe material must fail");
        assert_eq!(
            error,
            "Chaoxing OCR client material configuration is invalid"
        );
        assert!(!error.contains(unsafe_value));
    }
}
