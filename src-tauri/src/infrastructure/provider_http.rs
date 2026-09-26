use crate::application::state::CancellationSignal;
use crate::domain::providers::{
    derive_endpoints_with_protocol, exponential_backoff, retry_after, should_retry,
    should_rotate_key,
};
use crate::domain::settings::ProviderSettings;
use futures_util::StreamExt;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::Duration;

pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
pub const MAX_JSON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_AI_JSON_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_SSE_STREAM_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_AI_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const PROVIDER_MODEL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const GENERATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
static MODEL_HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

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
        .get_or_init(|| build_client(GENERATION_REQUEST_TIMEOUT))
        .as_ref()
        .map_err(Clone::clone)
}

pub fn models_client() -> Result<&'static Client, String> {
    MODEL_HTTP_CLIENT
        .get_or_init(|| build_client(PROVIDER_MODEL_REQUEST_TIMEOUT))
        .as_ref()
        .map_err(Clone::clone)
}

fn build_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent(format!("ScreenPilot/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
}

/// Convert a reqwest failure to a UI-safe, category-preserving message.
///
/// reqwest documents that its Display implementation may include the full
/// request URL.  Some OCR endpoints carry credentials in the query string, so
/// the raw error must never cross the application boundary.  We deliberately
/// use only the typed predicates here instead of formatting the error and then
/// attempting to redact an unbounded set of URL encodings.
pub fn safe_request_error(error: &reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection/TLS"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_builder() {
        "request configuration"
    } else if error.is_request() {
        "request"
    } else if error.is_body() {
        "response body"
    } else if error.is_decode() {
        "response decoding"
    } else if error.is_upgrade() {
        "connection upgrade"
    } else {
        "network"
    };
    format!("Network request failed ({category})")
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
            response = request.send() => response.map_err(|error| safe_request_error(&error)),
            _ = signal.cancelled() => Err("Request cancelled".into()),
        }
    } else {
        request
            .send()
            .await
            .map_err(|error| safe_request_error(&error))
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
        let chunk = chunk.map_err(|error| safe_request_error(&error))?;
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

pub async fn fetch_models(
    provider: &ProviderSettings,
    primary_key: Option<&str>,
) -> Result<Vec<String>, String> {
    provider_endpoint_is_safe(&provider.base_url)?;
    let endpoint = derive_endpoints_with_protocol(&provider.base_url, provider.protocol)?.models;
    let mut request = models_client()?.get(endpoint);
    if let Some(key) = primary_key.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| safe_request_error(&error))?;
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
    use std::net::TcpListener;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn provider(base_url: String) -> ProviderSettings {
        ProviderSettings {
            id: "test".into(),
            name: "Test".into(),
            base_url,
            protocol: crate::domain::providers::ApiProtocol::Responses,
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

    #[tokio::test]
    async fn dns_errors_do_not_include_raw_or_encoded_query_credentials() {
        let raw = "synthetic-client/id+%?=";
        let encoded = "synthetic-client%2Fid%2B%25%3F%3D";
        let double_encoded = "synthetic-client%252Fid%252B%2525%253F%253D";
        let request = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_secs(1))
            .build()
            .expect("test client")
            .get("http://screenpilot-a24-dns.invalid/ocr")
            .query(&[("access_token", raw)]);

        let error = send_request(request, None)
            .await
            .expect_err("the reserved invalid TLD must not resolve");
        assert!(error.starts_with("Network request failed ("));
        assert!(!error.contains(raw));
        assert!(!error.contains(encoded));
        assert!(!error.contains(double_encoded));
    }

    #[tokio::test]
    async fn connection_errors_do_not_include_url_query_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a local port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener);
        let raw = "synthetic-token/with+symbols?=";
        let request = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_secs(1))
            .build()
            .expect("test client")
            .get(format!("http://127.0.0.1:{port}/ocr"))
            .query(&[("access_token", raw)]);

        let error = send_request(request, None)
            .await
            .expect_err("the released local port must refuse the connection");
        assert!(error.starts_with("Network request failed ("));
        assert!(!error.contains(raw));
        assert!(!error.contains("synthetic-token%2Fwith%2Bsymbols%3F%3D"));
    }

    #[tokio::test]
    async fn timeout_errors_do_not_include_url_query_credentials() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/timeout"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(150))
                    .set_body_string("ok"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let raw = "synthetic-timeout/secret+%?=";
        let request = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(20))
            .build()
            .expect("test client")
            .get(format!("{}/timeout", server.uri()))
            .query(&[("access_token", raw)]);

        let error = send_request(request, None)
            .await
            .expect_err("the delayed response must time out");
        assert_eq!(error, "Network request failed (timeout)");
        assert!(!error.contains(raw));
        assert!(!error.contains("synthetic-timeout%2Fsecret%2B%25%3F%3D"));
    }

    #[tokio::test]
    async fn redirect_errors_do_not_include_url_query_credentials() {
        let server = MockServer::start().await;
        let raw = "synthetic-redirect/secret+%?=";
        let location = format!("{}/redirect?access_token={raw}", server.uri());
        Mock::given(method("GET"))
            .and(path("/redirect"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", location)
                    .set_body_string("redirect"),
            )
            .mount(&server)
            .await;
        let request = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::limited(1))
            .build()
            .expect("test client")
            .get(format!("{}/redirect", server.uri()))
            .query(&[("access_token", raw)]);

        let error = send_request(request, None)
            .await
            .expect_err("the redirect limit must fail");
        assert_eq!(error, "Network request failed (redirect)");
        assert!(!error.contains(raw));
        assert!(!error.contains("synthetic-redirect%2Fsecret%2B%25%3F%3D"));
    }

    #[test]
    fn reuses_one_http_client_for_all_requests() {
        let first = client().expect("shared client");
        let second = client().expect("shared client");
        assert!(std::ptr::eq(first, second));
    }

    #[test]
    fn model_requests_use_a_dedicated_short_timeout_client() {
        assert_eq!(PROVIDER_MODEL_REQUEST_TIMEOUT, Duration::from_secs(15));
        let generation = client().expect("generation client");
        let models = models_client().expect("model client");
        assert!(!std::ptr::eq(generation, models));
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
