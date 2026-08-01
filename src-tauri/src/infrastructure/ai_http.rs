use crate::domain::providers::{
    derive_endpoints, exponential_backoff, retry_after, should_retry, should_rotate_key,
    ApiProtocol,
};
use crate::domain::settings::ProviderSettings;
use crate::infrastructure::provider_http::client;
use crate::infrastructure::sse::{parse_openai_event, SseDecoder, SseDelta};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::time::sleep;

pub struct AiMessage<'a> {
    pub role: &'a str,
    pub content: &'a str,
}

pub struct VisionCompletion<'a> {
    pub provider: &'a ProviderSettings,
    pub model: &'a str,
    pub keys: &'a [String],
    pub system: &'a str,
    pub messages: &'a [AiMessage<'a>],
    pub image_url: Option<&'a str>,
    pub policy: AiRequestPolicy,
}

#[derive(Clone, Copy)]
pub struct AiRequestPolicy {
    pub attempts: u8,
    pub stream: bool,
}

impl AiRequestPolicy {
    pub fn new(retry_enabled: bool, attempts: u8, stream: bool) -> Self {
        Self {
            attempts: if retry_enabled {
                attempts.clamp(1, 5)
            } else {
                1
            },
            stream,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AiStreamFinish {
    Done,
    Cancelled,
}

#[derive(Default)]
struct KeyRuntime {
    recent: HashMap<String, [u8; 32]>,
    cooling: HashMap<(String, [u8; 32]), Instant>,
}

static KEY_RUNTIME: OnceLock<Mutex<KeyRuntime>> = OnceLock::new();

pub async fn complete_text(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
) -> Result<String, String> {
    let endpoints = derive_endpoints(&provider.base_url)?;
    let body = match endpoints.protocol {
        ApiProtocol::ChatCompletions => json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "stream": policy.stream
        }),
        ApiProtocol::Responses => json!({
            "model": model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system}]},
                {"role": "user", "content": [{"type": "input_text", "text": user}]}
            ],
            "stream": policy.stream
        }),
    };
    send_completion(provider, model, keys, body, endpoints.protocol, policy).await
}

pub async fn complete_vision(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
) -> Result<String, String> {
    let endpoints = derive_endpoints(&provider.base_url)?;
    let last_user = messages.iter().rposition(|message| message.role == "user");
    let body = match endpoints.protocol {
        ApiProtocol::ChatCompletions => {
            let mut values = vec![json!({"role": "system", "content": system})];
            for (index, message) in messages.iter().enumerate() {
                if Some(index) == last_user && image_url.is_some() {
                    values.push(json!({
                        "role": message.role,
                        "content": [
                            {"type": "text", "text": message.content},
                            {"type": "image_url", "image_url": {"url": image_url}}
                        ]
                    }));
                } else {
                    values.push(json!({"role": message.role, "content": message.content}));
                }
            }
            json!({"model": model, "messages": values, "stream": policy.stream})
        }
        ApiProtocol::Responses => {
            let mut values = vec![json!({
                "role": "system",
                "content": [{"type": "input_text", "text": system}]
            })];
            for (index, message) in messages.iter().enumerate() {
                let mut content = vec![json!({"type": "input_text", "text": message.content})];
                if Some(index) == last_user {
                    if let Some(url) = image_url {
                        content.push(json!({"type": "input_image", "image_url": url}));
                    }
                }
                values.push(json!({"role": message.role, "content": content}));
            }
            json!({"model": model, "input": values, "stream": policy.stream})
        }
    };
    send_completion(provider, model, keys, body, endpoints.protocol, policy).await
}

pub async fn stream_vision<F, C>(
    input: VisionCompletion<'_>,
    mut on_delta: F,
    cancelled: C,
) -> Result<AiStreamFinish, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
    C: Fn() -> bool,
{
    let endpoints = derive_endpoints(&input.provider.base_url)?;
    let last_user = input
        .messages
        .iter()
        .rposition(|message| message.role == "user");
    let body = match endpoints.protocol {
        ApiProtocol::ChatCompletions => {
            let mut values = vec![json!({"role": "system", "content": input.system})];
            for (index, message) in input.messages.iter().enumerate() {
                if Some(index) == last_user && input.image_url.is_some() {
                    values.push(json!({
                        "role": message.role,
                        "content": [
                            {"type": "text", "text": message.content},
                            {"type": "image_url", "image_url": {"url": input.image_url}}
                        ]
                    }));
                } else {
                    values.push(json!({"role": message.role, "content": message.content}));
                }
            }
            json!({"model": input.model, "messages": values, "stream": true})
        }
        ApiProtocol::Responses => {
            let mut values = vec![json!({
                "role": "system",
                "content": [{"type": "input_text", "text": input.system}]
            })];
            for (index, message) in input.messages.iter().enumerate() {
                let mut content = vec![json!({"type": "input_text", "text": message.content})];
                if Some(index) == last_user {
                    if let Some(url) = input.image_url {
                        content.push(json!({"type": "input_image", "image_url": url}));
                    }
                }
                values.push(json!({"role": message.role, "content": content}));
            }
            json!({"model": input.model, "input": values, "stream": true})
        }
    };
    let response =
        request_with_failover(input.provider, input.model, input.keys, &body, input.policy).await?;
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    while let Some(chunk) = stream.next().await {
        if cancelled() {
            return Ok(AiStreamFinish::Cancelled);
        }
        for event in decoder.push(&chunk.map_err(|error| error.to_string())?)? {
            if consume_sse_event(&event, &mut on_delta)? {
                return Ok(AiStreamFinish::Done);
            }
        }
    }
    for event in decoder.finish()? {
        if consume_sse_event(&event, &mut on_delta)? {
            return Ok(AiStreamFinish::Done);
        }
    }
    Ok(if cancelled() {
        AiStreamFinish::Cancelled
    } else {
        AiStreamFinish::Done
    })
}

async fn send_completion(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    body: Value,
    protocol: ApiProtocol,
    policy: AiRequestPolicy,
) -> Result<String, String> {
    let response = request_with_failover(provider, model, keys, &body, policy).await?;
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Provider response is invalid: {error}"))?;
    parse_text(protocol, &value)
}

async fn request_with_failover(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    body: &Value,
    policy: AiRequestPolicy,
) -> Result<reqwest::Response, String> {
    if model.trim().is_empty() {
        return Err("A model must be selected".into());
    }
    if keys.is_empty() {
        return Err("The selected provider has no API key".into());
    }
    let request_url = derive_endpoints(&provider.base_url)?.request;
    let identity = format!("{}|{}", provider.id, provider.base_url);
    let mut last_error = "Provider request failed".to_string();
    for attempt in 0..policy.attempts {
        let mut retriable = false;
        let mut delay = exponential_backoff(attempt);
        for index in ordered_key_indices(&identity, keys, Instant::now()) {
            let key = &keys[index];
            let response = client()?
                .post(request_url.clone())
                .bearer_auth(key)
                .json(body)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    last_error = error.to_string();
                    retriable = true;
                    break;
                }
            };
            let status = response.status();
            if status.is_success() {
                mark_key_success(&identity, key);
                return Ok(response);
            }
            let retry_delay = retry_after(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok()),
            );
            let status_code = status.as_u16();
            let text = response.text().await.unwrap_or_default();
            let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            last_error = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map_or_else(
                    || format!("Provider returned HTTP {status_code}"),
                    str::to_string,
                );
            if should_rotate_key(status_code) {
                mark_key_cooling(&identity, key, Instant::now());
                retriable = status_code == 429;
                if let Some(value) = retry_delay {
                    delay = value;
                }
                continue;
            }
            if should_retry(Some(status_code)) {
                retriable = true;
                if let Some(value) = retry_delay {
                    delay = value;
                }
                break;
            }
            return Err(last_error);
        }
        if !retriable || attempt + 1 >= policy.attempts {
            return Err(last_error);
        }
        if !delay.is_zero() {
            sleep(delay).await;
        }
    }
    Err(last_error)
}

fn consume_sse_event<F>(event: &str, on_delta: &mut F) -> Result<bool, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
{
    for delta in parse_openai_event(event)? {
        match delta {
            SseDelta::Done => return Ok(true),
            SseDelta::Error(error) => return Err(error),
            value => on_delta(value)?,
        }
    }
    Ok(false)
}

fn key_fingerprint(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

fn ordered_key_indices(identity: &str, keys: &[String], now: Instant) -> Vec<usize> {
    let runtime = KEY_RUNTIME
        .get_or_init(|| Mutex::new(KeyRuntime::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let recent = runtime.recent.get(identity);
    let mut available = keys
        .iter()
        .enumerate()
        .filter_map(|(index, key)| {
            let fingerprint = key_fingerprint(key);
            let cooling = runtime
                .cooling
                .get(&(identity.to_string(), fingerprint))
                .is_some_and(|until| *until > now);
            (!cooling).then_some((index, recent == Some(&fingerprint)))
        })
        .collect::<Vec<_>>();
    if available.is_empty() {
        available = keys
            .iter()
            .enumerate()
            .map(|(index, key)| (index, recent == Some(&key_fingerprint(key))))
            .collect();
    }
    available.sort_by_key(|(index, is_recent)| (!*is_recent, *index));
    available.into_iter().map(|(index, _)| index).collect()
}

fn mark_key_cooling(identity: &str, key: &str, now: Instant) {
    let mut runtime = KEY_RUNTIME
        .get_or_init(|| Mutex::new(KeyRuntime::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    runtime.cooling.insert(
        (identity.to_string(), key_fingerprint(key)),
        now + Duration::from_secs(60),
    );
}

fn mark_key_success(identity: &str, key: &str) {
    let mut runtime = KEY_RUNTIME
        .get_or_init(|| Mutex::new(KeyRuntime::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    runtime
        .recent
        .insert(identity.to_string(), key_fingerprint(key));
}

fn parse_text(protocol: ApiProtocol, value: &Value) -> Result<String, String> {
    let text = match protocol {
        ApiProtocol::ChatCompletions => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        ApiProtocol::Responses => value
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("content").and_then(Value::as_array))
            .flatten()
            .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
            .filter_map(|content| content.get("text").and_then(Value::as_str))
            .reduce(|left, right| if left.is_empty() { right } else { left })
            .map(str::to_string),
    };
    text.filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Provider returned an empty response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn provider(base_url: String) -> ProviderSettings {
        ProviderSettings {
            id: "test".into(),
            name: "Test".into(),
            base_url,
            key_count: 1,
            available_models: vec!["model:vision".into()],
            enabled_models: vec!["model:vision".into()],
        }
    }

    #[tokio::test]
    async fn constructs_chat_completions_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "messages": [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "user"}
                ],
                "stream": false
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"content": "answer"}}]
            })))
            .mount(&server)
            .await;
        let answer = complete_text(
            &provider(format!("{}/v1", server.uri())),
            "model:vision",
            &["secret".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
        )
        .await
        .expect("complete text");
        assert_eq!(answer, "answer");
    }

    #[tokio::test]
    async fn constructs_responses_request_and_rotates_auth_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer rejected"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"error": {"message": "bad key"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer working"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [{"content": [{"type": "output_text", "text": "response answer"}]}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let answer = complete_text(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["rejected".into(), "working".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
        )
        .await
        .expect("complete text");
        assert_eq!(answer, "response answer");
    }

    #[test]
    fn prioritizes_recent_success_and_skips_keys_during_cooldown() {
        let identity = "key-order-test";
        let keys = vec!["alpha".to_string(), "beta".to_string()];
        let now = Instant::now();
        mark_key_success(identity, &keys[1]);
        assert_eq!(ordered_key_indices(identity, &keys, now), vec![1, 0]);
        mark_key_cooling(identity, &keys[1], now);
        assert_eq!(ordered_key_indices(identity, &keys, now), vec![0]);
        mark_key_cooling(identity, &keys[0], now);
        assert_eq!(ordered_key_indices(identity, &keys, now), vec![1, 0]);
        assert_eq!(
            ordered_key_indices(identity, &keys, now + Duration::from_secs(61)),
            vec![1, 0]
        );
    }

    #[tokio::test]
    async fn streams_chat_text_reasoning_and_done_events() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer stream-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "messages": [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "question"}
                ],
                "stream": true
            })))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thought\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n",
                    "data: [DONE]\n\n"
                ),
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let mut deltas = Vec::new();
        let finish = stream_vision(
            VisionCompletion {
                provider: &provider(format!("{}/v1", server.uri())),
                model: "model:vision",
                keys: &["stream-secret".into()],
                system: "system",
                messages: &[AiMessage {
                    role: "user",
                    content: "question",
                }],
                image_url: None,
                policy: AiRequestPolicy::new(true, 3, true),
            },
            |delta| {
                deltas.push(delta);
                Ok(())
            },
            || false,
        )
        .await
        .expect("stream completion");
        assert_eq!(finish, AiStreamFinish::Done);
        assert_eq!(
            deltas,
            vec![
                SseDelta::Reasoning("thought".into()),
                SseDelta::Text("answer".into())
            ]
        );
    }
}
