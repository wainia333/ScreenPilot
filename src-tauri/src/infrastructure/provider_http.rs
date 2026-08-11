use crate::application::state::CancellationSignal;
use crate::domain::providers::{
    derive_endpoints, exponential_backoff, retry_after, should_retry, should_rotate_key,
};
use crate::domain::settings::ProviderSettings;
use futures_util::StreamExt;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::Duration;

pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_AI_JSON_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_SSE_STREAM_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_AI_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelItem>,
}

#[derive(Deserialize)]
struct ModelItem {
    id: String,
}

pub fn client() -> Result<&'static Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(15))
                // Responses reasoning and web-search streams can legitimately stay
                // open for longer than a conventional short HTTP request timeout.
                .timeout(Duration::from_secs(300))
                .user_agent(format!("ScreenPilot/{}", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub async fn send_request(
    request: reqwest::RequestBuilder,
    cancellation: Option<&CancellationSignal>,
) -> Result<reqwest::Response, String> {
    if let Some(signal) = cancellation {
        if signal.is_cancelled() {
            return Err("Request cancelled".into());
        }
        tokio::select! {
            response = request.send() => response.map_err(|error| error.to_string()),
            _ = signal.cancelled() => Err("Request cancelled".into()),
        }
    } else {
        request.send().await.map_err(|error| error.to_string())
    }
}

pub async fn read_response_bytes_limited(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<Vec<u8>, String> {
    if cancellation.is_some_and(CancellationSignal::is_cancelled) {
        return Err("Request cancelled".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("{label} exceeds the {limit}-byte limit"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let next = if let Some(signal) = cancellation {
            tokio::select! {
                next = stream.next() => next,
                _ = signal.cancelled() => return Err("Request cancelled".into()),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| error.to_string())?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!("{label} exceeds the {limit}-byte limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn read_json_limited<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<T, String> {
    let bytes = read_response_bytes_limited(response, limit, label, cancellation).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{label} is invalid: {error}"))
}

pub async fn read_text_limited(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let bytes = read_response_bytes_limited(response, limit, label, cancellation).await?;
    String::from_utf8(bytes).map_err(|error| format!("{label} is not valid UTF-8: {error}"))
}

pub async fn read_json_response_limited<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        let _ = read_response_bytes_limited(
            response,
            MAX_ERROR_BODY_BYTES,
            "Remote error response",
            cancellation,
        )
        .await;
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        return Err(format!("{label} returned HTTP {}", status.as_u16()));
    }
    read_json_limited(response, limit, label, cancellation).await
}

pub async fn read_text_response_limited(
    response: reqwest::Response,
    limit: usize,
    label: &str,
    cancellation: Option<&CancellationSignal>,
) -> Result<String, String> {
    let status = response.status();
    if !status.is_success() {
        let _ = read_response_bytes_limited(
            response,
            MAX_ERROR_BODY_BYTES,
            "Remote error response",
            cancellation,
        )
        .await;
        if cancellation.is_some_and(CancellationSignal::is_cancelled) {
            return Err("Request cancelled".into());
        }
        return Err(format!("{label} returned HTTP {}", status.as_u16()));
    }
    read_text_limited(response, limit, label, cancellation).await
}

pub async fn fetch_models(
    provider: &ProviderSettings,
    primary_key: Option<&str>,
) -> Result<Vec<String>, String> {
    provider_endpoint_is_safe(&provider.base_url)?;
    let endpoint = derive_endpoints(&provider.base_url)?.models;
    let mut request = client()?.get(endpoint);
    if let Some(key) = primary_key.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let _retry_policy = (
        exponential_backoff(0),
        retry_after(
            response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok()),
        ),
        should_retry(Some(response.status().as_u16())),
        should_rotate_key(response.status().as_u16()),
    );
    if !response.status().is_success() {
        return Err(format!(
            "Provider returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut models = read_json_limited::<ModelList>(
        response,
        MAX_JSON_RESPONSE_BYTES,
        "Provider model response",
        None,
    )
    .await?
    .data
    .into_iter()
    .map(|item| item.id.trim().to_string())
    .filter(|id| !id.is_empty())
    .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(models)
}

pub async fn test_connection(provider: &ProviderSettings, primary_key: &str) -> Result<(), String> {
    if primary_key.trim().is_empty() {
        return Err("Primary API key is required".into());
    }
    fetch_models(provider, Some(primary_key)).await.map(|_| ())
}

fn provider_endpoint_is_safe(value: &str) -> Result<(), String> {
    let endpoint = url::Url::parse(value).map_err(|_| "Provider URL is invalid")?;
    let local = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() == "https" || (local && endpoint.scheme() == "http") {
        Ok(())
    } else {
        Err("Provider URL must use HTTPS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn provider(base_url: String) -> ProviderSettings {
        ProviderSettings {
            id: "test".into(),
            name: "Test".into(),
            base_url,
            key_count: 0,
            available_models: Vec::new(),
            enabled_models: Vec::new(),
        }
    }

    #[tokio::test]
    async fn fetches_sorted_models_with_primary_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("authorization", "Bearer primary-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "z:model"}, {"id": "a-model"}, {"id": "a-model"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let models = fetch_models(
            &provider(format!("{}/v1/chat/completions", server.uri())),
            Some("primary-secret"),
        )
        .await
        .expect("fetch models");
        assert_eq!(models, ["a-model", "z:model"]);
    }

    #[tokio::test]
    async fn rejects_remote_plain_http_before_networking() {
        let error = fetch_models(&provider("http://example.com/v1".into()), None)
            .await
            .unwrap_err();
        assert_eq!(error, "Provider URL must use HTTPS");
    }

    #[tokio::test]
    async fn connection_errors_do_not_include_the_primary_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_string("primary-secret must not appear in the error"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = test_connection(&provider(format!("{}/v1", server.uri())), "primary-secret")
            .await
            .unwrap_err();
        assert_eq!(error, "Provider returned HTTP 401");
        assert!(!error.contains("primary-secret"));
    }

    #[test]
    fn reuses_one_http_client_for_all_requests() {
        let first = client().expect("shared client");
        let second = client().expect("shared client");
        assert!(std::ptr::eq(first, second));
    }

    #[tokio::test]
    async fn rejects_oversized_model_json_before_deserializing_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![
                b' ';
                MAX_JSON_RESPONSE_BYTES
                    + 1
            ]))
            .expect(1)
            .mount(&server)
            .await;

        let error = fetch_models(&provider(format!("{}/v1", server.uri())), None)
            .await
            .expect_err("oversized model response must fail");
        assert!(error.contains("exceeds the"));
        assert!(error.contains("byte limit"));
    }

    #[tokio::test]
    async fn bounded_reader_rejects_bodies_larger_than_its_call_site_limit() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/bounded"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"12345"))
            .expect(1)
            .mount(&server)
            .await;
        let response = client()
            .expect("shared client")
            .get(format!("{}/bounded", server.uri()))
            .send()
            .await
            .expect("bounded response");

        assert_eq!(
            read_response_bytes_limited(response, 4, "Test response", None).await,
            Err("Test response exceeds the 4-byte limit".into())
        );
    }

    #[tokio::test]
    async fn bounded_reader_honors_an_already_cancelled_signal() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cancelled"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"ok"))
            .expect(1)
            .mount(&server)
            .await;
        let response = client()
            .expect("shared client")
            .get(format!("{}/cancelled", server.uri()))
            .send()
            .await
            .expect("cancelled response");
        let signal = CancellationSignal::new();
        signal.cancel();

        assert_eq!(
            read_response_bytes_limited(response, 4, "Test response", Some(&signal)).await,
            Err("Request cancelled".into())
        );
    }
}
