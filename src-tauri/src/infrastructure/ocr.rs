use crate::infrastructure::ocr_text::{normalize_ocr_lines, normalize_ocr_paragraphs};
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

const BAIDU_TOKEN_ENDPOINT: &str = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR_ENDPOINT: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic";

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
        Ok(normalize_ocr_lines(&lines))
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
    baidu_with_endpoints(
        image,
        credentials,
        BaiduEndpoints {
            token: BAIDU_TOKEN_ENDPOINT,
            ocr: BAIDU_OCR_ENDPOINT,
        },
    )
    .await
}

struct BaiduEndpoints<'a> {
    token: &'a str,
    ocr: &'a str,
}

async fn baidu_with_endpoints(
    image: &[u8],
    credentials: &[String],
    endpoints: BaiduEndpoints<'_>,
) -> Result<String, String> {
    let [api_key, secret_key, ..] = credentials else {
        return Err("Baidu OCR API key and secret key are required".into());
    };
    let token_response = send_request(
        client()?.post(endpoints.token).query(&[
            ("grant_type", "client_credentials"),
            ("client_id", api_key),
            ("client_secret", secret_key),
        ]),
        None,
    )
    .await?;
    let token_value = read_baidu_json_response(
        token_response,
        MAX_JSON_RESPONSE_BYTES,
        "Baidu OCR authentication response",
        None,
    )
    .await?;
    let token = token_value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| baidu_error_from_json(&token_value, true))?;
    let response = send_request(
        client()?
            .post(endpoints.ocr)
            .query(&[("access_token", token)])
            .form(&[
                ("image", STANDARD.encode(image)),
                ("paragraph", "true".to_string()),
            ]),
        None,
    )
    .await?;
    let value = read_baidu_json_response(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Baidu OCR response",
        None,
    )
    .await?;
    if value.get("error_msg").and_then(Value::as_str).is_some() || value.get("error_code").is_some()
    {
        return Err(baidu_error_from_json(&value, false));
    }
    let lines = value
        .get("words_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("words").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        Err("Baidu OCR returned no visible text".into())
    } else {
        let paragraphs = baidu_paragraphs(&value, &lines);
        if paragraphs.is_empty() {
            Ok(normalize_ocr_lines(&lines))
        } else {
            Ok(normalize_ocr_paragraphs(&paragraphs))
        }
    }
}

fn baidu_paragraphs(value: &Value, lines: &[String]) -> Vec<Vec<String>> {
    let mut index_groups = value
        .get("paragraphs_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|paragraph| paragraph.get("words_result_idx").and_then(Value::as_array))
        .filter_map(|indices| {
            let mut indices = indices
                .iter()
                .filter_map(Value::as_u64)
                .filter_map(|index| usize::try_from(index).ok())
                .filter(|index| *index < lines.len())
                .collect::<Vec<_>>();
            indices.sort_unstable();
            indices.dedup();
            (!indices.is_empty()).then_some(indices)
        })
        .collect::<Vec<_>>();
    index_groups.sort_by_key(|indices| indices[0]);

    let mut assigned = vec![false; lines.len()];
    for indices in &index_groups {
        for index in indices {
            assigned[*index] = true;
        }
    }

    let mut paragraphs = Vec::new();
    let mut group_index = 0usize;
    for line_index in 0..lines.len() {
        while index_groups
            .get(group_index)
            .is_some_and(|indices| indices[0] == line_index)
        {
            paragraphs.push(
                index_groups[group_index]
                    .iter()
                    .filter_map(|index| lines.get(*index).cloned())
                    .collect(),
            );
            group_index += 1;
        }
        if !assigned[line_index] {
            paragraphs.push(vec![lines[line_index].clone()]);
        }
    }
    paragraphs
}

async fn read_baidu_json_response(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&crate::application::state::CancellationSignal>,
) -> Result<Value, String> {
    let status = response.status();
    read_json_response_limited::<Value>(response, limit, label, cancellation)
        .await
        .map_err(|error| {
            if status.is_success() {
                error
            } else {
                baidu_http_status_error(status.as_u16())
            }
        })
}

fn baidu_http_status_error(status: u16) -> String {
    match status {
        401 | 403 => format!("Baidu OCR authentication failed (HTTP {status})"),
        408 => format!("Baidu OCR request timed out (HTTP {status})"),
        429 => format!("Baidu OCR rate limit exceeded (HTTP {status})"),
        500..=599 => format!("Baidu OCR service unavailable (HTTP {status})"),
        _ => format!("Baidu OCR request rejected (HTTP {status})"),
    }
}

fn baidu_error_from_json(value: &Value, authentication: bool) -> String {
    let code = value.get("error_code").and_then(Value::as_i64);
    let rate_limited = matches!(code, Some(17 | 18 | 19 | 282000));
    let authentication_failed =
        authentication || matches!(code, Some(110 | 111 | 216100 | 216101 | 216102 | 216103));
    if rate_limited {
        "Baidu OCR rate limit exceeded".into()
    } else if authentication_failed {
        "Baidu OCR authentication failed".into()
    } else {
        "Baidu OCR request rejected".into()
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
    use std::net::TcpListener;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn extracts_nested_visible_text() {
        let value = json!({"blocks": [{"text": "first"}, {"children": [{"text": "第二行"}]}]});
        let mut lines = Vec::new();
        collect_text(&value, &mut lines);
        assert_eq!(lines, ["first", "第二行"]);
    }

    #[test]
    fn uses_baidu_paragraph_indices_in_reading_order() {
        let value = json!({
            "paragraphs_result": [
                {"words_result_idx": [3]},
                {"words_result_idx": [0, 1]}
            ]
        });
        let lines = vec![
            "First".into(),
            "paragraph.".into(),
            "Unassigned paragraph.".into(),
            "Second paragraph.".into(),
        ];

        assert_eq!(
            baidu_paragraphs(&value, &lines),
            vec![
                vec!["First".to_string(), "paragraph.".to_string()],
                vec!["Unassigned paragraph.".to_string()],
                vec!["Second paragraph.".to_string()]
            ]
        );
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

    #[tokio::test]
    async fn baidu_authentication_json_does_not_echo_query_credentials() {
        let server = MockServer::start().await;
        let api_key = "synthetic-client/id+%?=";
        let secret_key = "synthetic-secret/id+%?=";
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .and(query_param("client_id", api_key))
            .and(query_param("client_secret", secret_key))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "error": "invalid_client",
                "error_code": 110,
                "error_description": format!(
                    "client_secret={secret_key}; encoded=synthetic-secret%2Fid%2B%25%3F%3D"
                )
            })))
            .expect(1)
            .mount(&server)
            .await;

        let token_endpoint = format!("{}/oauth/token", server.uri());
        let ocr_endpoint = format!("{}/ocr", server.uri());
        let credentials = vec![api_key.to_string(), secret_key.to_string()];
        let error = baidu_with_endpoints(
            &[],
            &credentials,
            BaiduEndpoints {
                token: &token_endpoint,
                ocr: &ocr_endpoint,
            },
        )
        .await
        .expect_err("the synthetic authentication response must fail");

        assert_eq!(error, "Baidu OCR authentication failed");
        assert!(!error.contains(api_key));
        assert!(!error.contains(secret_key));
        assert!(!error.contains("synthetic-client%2Fid%2B%25%3F%3D"));
        assert!(!error.contains("synthetic-secret%252Fid%252B%2525%253F%253D"));
    }

    #[tokio::test]
    async fn baidu_token_connection_error_does_not_echo_encoded_access_token() {
        let token_server = MockServer::start().await;
        let api_key = "synthetic-client/id+%?=";
        let secret_key = "synthetic-secret/id+%?=";
        let access_token = "synthetic-access/id+%?=";
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": access_token
            })))
            .expect(1)
            .mount(&token_server)
            .await;

        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a local port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener);
        let token_endpoint = format!("{}/oauth/token", token_server.uri());
        let ocr_endpoint = format!("http://127.0.0.1:{port}/ocr");
        let credentials = vec![api_key.to_string(), secret_key.to_string()];
        let error = baidu_with_endpoints(
            &[],
            &credentials,
            BaiduEndpoints {
                token: &token_endpoint,
                ocr: &ocr_endpoint,
            },
        )
        .await
        .expect_err("the released local port must refuse the OCR request");

        assert!(error.starts_with("Network request failed ("));
        for value in [
            api_key,
            secret_key,
            access_token,
            "synthetic-client%2Fid%2B%25%3F%3D",
            "synthetic-secret%2Fid%2B%25%3F%3D",
            "synthetic-access%2Fid%2B%25%3F%3D",
            "synthetic-access%252Fid%252B%2525%253F%253D",
        ] {
            assert!(!error.contains(value), "error leaked {value:?}: {error}");
        }
    }

    #[tokio::test]
    async fn baidu_token_network_error_does_not_echo_client_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a local port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener);
        let api_key = "synthetic-client/id+%?=";
        let secret_key = "synthetic-secret/id+%?=";
        let token_endpoint = format!("http://127.0.0.1:{port}/oauth/token");
        let ocr_endpoint = format!("http://127.0.0.1:{port}/ocr");
        let credentials = vec![api_key.to_string(), secret_key.to_string()];

        let error = baidu_with_endpoints(
            &[],
            &credentials,
            BaiduEndpoints {
                token: &token_endpoint,
                ocr: &ocr_endpoint,
            },
        )
        .await
        .expect_err("the released local port must refuse token acquisition");

        assert!(error.starts_with("Network request failed ("));
        for value in [
            api_key,
            secret_key,
            "synthetic-client%2Fid%2B%25%3F%3D",
            "synthetic-secret%2Fid%2B%25%3F%3D",
            "synthetic-client%252Fid%252B%2525%253F%253D",
            "synthetic-secret%252Fid%252B%2525%253F%253D",
        ] {
            assert!(!error.contains(value), "error leaked {value:?}: {error}");
        }
    }

    #[tokio::test]
    async fn baidu_http_and_error_json_failures_keep_safe_categories() {
        let server = MockServer::start().await;
        let secret_key = "synthetic-secret/http-error";
        Mock::given(method("POST"))
            .and(path("/http-error"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error_msg": format!("secret_key={secret_key}"),
                "error_code": 18
            })))
            .expect(1)
            .mount(&server)
            .await;
        let response = client()
            .expect("shared client")
            .post(format!("{}/http-error", server.uri()))
            .query(&[("access_token", "synthetic-access/http-error")])
            .send()
            .await
            .expect("controlled HTTP error response");
        let error = read_baidu_json_response(
            response,
            MAX_JSON_RESPONSE_BYTES,
            "Baidu OCR response",
            None,
        )
        .await
        .expect_err("HTTP 429 must fail");
        assert_eq!(error, "Baidu OCR rate limit exceeded (HTTP 429)");
        assert!(!error.contains(secret_key));

        Mock::given(method("POST"))
            .and(path("/invalid-json"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("not-json synthetic-secret/http-error"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let response = client()
            .expect("shared client")
            .post(format!("{}/invalid-json", server.uri()))
            .send()
            .await
            .expect("controlled invalid JSON response");
        let error = read_baidu_json_response(
            response,
            MAX_JSON_RESPONSE_BYTES,
            "Baidu OCR response",
            None,
        )
        .await
        .expect_err("invalid JSON must fail");
        assert!(error.starts_with("Baidu OCR response is invalid:"));
        assert!(!error.contains(secret_key));
    }

    #[tokio::test]
    async fn baidu_error_json_does_not_echo_access_token() {
        let server = MockServer::start().await;
        let access_token = "synthetic-access/error-json";
        Mock::given(method("POST"))
            .and(path("/ocr"))
            .and(query_param("access_token", access_token))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "error_code": 18,
                "error_msg": format!("access_token={access_token}")
            })))
            .expect(1)
            .mount(&server)
            .await;
        let token_endpoint = format!("{}/token", server.uri());
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": access_token
            })))
            .expect(1)
            .mount(&server)
            .await;
        let ocr_endpoint = format!("{}/ocr", server.uri());
        let credentials = vec!["synthetic-client".into(), "synthetic-secret".into()];
        let error = baidu_with_endpoints(
            &[],
            &credentials,
            BaiduEndpoints {
                token: &token_endpoint,
                ocr: &ocr_endpoint,
            },
        )
        .await
        .expect_err("the controlled Baidu error JSON must fail");

        assert_eq!(error, "Baidu OCR rate limit exceeded");
        assert!(!error.contains(access_token));
        assert!(!error.contains("synthetic-access%2Ferror-json"));
    }

    #[test]
    fn baidu_http_errors_preserve_auth_timeout_rate_and_service_categories() {
        assert_eq!(
            baidu_http_status_error(401),
            "Baidu OCR authentication failed (HTTP 401)"
        );
        assert_eq!(
            baidu_http_status_error(408),
            "Baidu OCR request timed out (HTTP 408)"
        );
        assert_eq!(
            baidu_http_status_error(429),
            "Baidu OCR rate limit exceeded (HTTP 429)"
        );
        assert_eq!(
            baidu_http_status_error(503),
            "Baidu OCR service unavailable (HTTP 503)"
        );
        assert_eq!(
            baidu_http_status_error(400),
            "Baidu OCR request rejected (HTTP 400)"
        );
    }
}
