use crate::domain::providers::{
    derive_endpoints, exponential_backoff, retry_after, should_retry, should_rotate_key,
};
use crate::domain::settings::ProviderSettings;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelItem>,
}

#[derive(Deserialize)]
struct ModelItem {
    id: String,
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(format!("ScreenPilot/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
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
    let mut models = response
        .json::<ModelList>()
        .await
        .map_err(|error| format!("Provider model response is invalid: {error}"))?
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
}
