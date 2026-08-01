use crate::infrastructure::provider_http::client;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use md5::{Digest, Md5};
use serde_json::{json, Value};

pub async fn chaoxing(image: &[u8]) -> Result<String, String> {
    if image.len() > 5 * 1024 * 1024 {
        return Err("Chaoxing OCR accepts images up to 5MB".into());
    }
    let timestamp = Utc::now().timestamp_millis();
    let body = json!({
        "images": [{"data": STANDARD.encode(image), "dataId": "1", "type": 2}],
        "nonce": timestamp.unsigned_abs() % 100_000,
        "secretId": "Inner_40731a6efece4c2e992c0d670222e6da",
        "timestamp": timestamp
    });
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let signature = format!(
        "{:x}",
        Md5::digest(format!("{body_text}43e7a66431b14c8f856a8e889070c19b"))
    );
    let value = client()?
        .post("https://ai.chaoxing.com/api/v1/ocr/common/sync")
        .header("content-type", "application/json;charset=utf-8")
        .header("cx-signature", signature)
        .body(body_text)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
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

pub async fn baidu(image: &[u8], credentials: &[String]) -> Result<String, String> {
    let [api_key, secret_key, ..] = credentials else {
        return Err("Baidu OCR API key and secret key are required".into());
    };
    let token_value = client()?
        .post("https://aip.baidubce.com/oauth/2.0/token")
        .query(&[
            ("grant_type", "client_credentials"),
            ("client_id", api_key),
            ("client_secret", secret_key),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let token = token_value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Baidu OCR authentication failed")?;
    let value = client()?
        .post("https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic")
        .query(&[("access_token", token)])
        .form(&[
            ("image", STANDARD.encode(image)),
            ("paragraph", "true".to_string()),
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
}
