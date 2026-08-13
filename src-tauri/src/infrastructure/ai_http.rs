use crate::application::state::CancellationSignal;
use crate::domain::providers::{
    derive_endpoints, exponential_backoff, retry_after, should_retry, should_rotate_key,
    ApiProtocol,
};
use crate::domain::settings::ProviderSettings;
use crate::domain::settings::ThinkingEffort;
use crate::infrastructure::provider_http::{
    client, read_json_limited, read_text_limited, MAX_AI_JSON_RESPONSE_BYTES, MAX_AI_OUTPUT_BYTES,
    MAX_ERROR_BODY_BYTES, MAX_SSE_STREAM_BYTES,
};
use crate::infrastructure::sse::{parse_openai_event, SseDecoder, SseDelta};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::time::sleep;
use url::Url;

#[cfg(test)]
use std::sync::Weak;
#[cfg(test)]
use tokio::sync::Notify;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestClientPhase {
    RetrySleep,
    ResponseJsonBody,
    ErrorBody,
    SseNext,
}

#[cfg(test)]
struct TestClientPhaseObserver {
    token: usize,
    phases: Mutex<Vec<TestClientPhase>>,
    notify: Notify,
}

#[cfg(test)]
static TEST_CLIENT_PHASE_OBSERVERS: OnceLock<Mutex<HashMap<usize, Weak<TestClientPhaseObserver>>>> =
    OnceLock::new();

#[cfg(test)]
fn test_client_token(signal: &Arc<CancellationSignal>) -> usize {
    Arc::as_ptr(signal) as usize
}

#[cfg(test)]
fn new_test_client_phase_observer(
    signal: &Arc<CancellationSignal>,
) -> Arc<TestClientPhaseObserver> {
    let token = test_client_token(signal);
    let observer = Arc::new(TestClientPhaseObserver {
        token,
        phases: Mutex::new(Vec::new()),
        notify: Notify::new(),
    });
    TEST_CLIENT_PHASE_OBSERVERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("client phase observers lock")
        .insert(token, Arc::downgrade(&observer));
    observer
}

#[cfg(test)]
fn notify_test_client_phase(signal: &Arc<CancellationSignal>, phase: TestClientPhase) {
    let Some(observers) = TEST_CLIENT_PHASE_OBSERVERS.get() else {
        return;
    };
    let mut observers = observers.lock().expect("client phase observers lock");
    let token = test_client_token(signal);
    let Some(observer) = observers.get(&token).and_then(Weak::upgrade) else {
        observers.remove(&token);
        return;
    };
    if observer.token == token {
        observer
            .phases
            .lock()
            .expect("client phase lock")
            .push(phase);
        observer.notify.notify_waiters();
    }
}

#[cfg(test)]
async fn wait_test_client_phase(observer: &Arc<TestClientPhaseObserver>, phase: TestClientPhase) {
    loop {
        let notified = observer.notify.notified();
        let found = {
            let mut phases = observer.phases.lock().expect("client phase lock");
            if let Some(index) = phases.iter().position(|candidate| *candidate == phase) {
                phases.remove(index);
                true
            } else {
                false
            }
        };
        if found {
            return;
        }
        notified.await;
    }
}

#[cfg(test)]
macro_rules! notify_client_phase {
    ($signal:expr, $phase:expr) => {
        notify_test_client_phase($signal, $phase)
    };
}

#[cfg(not(test))]
macro_rules! notify_client_phase {
    ($signal:expr, $phase:expr) => {{
        let _ = &$signal;
    }};
}

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

/// Optional Responses API features used by Vision requests.
///
/// Chat Completions providers continue to receive their existing payload. These
/// options are only serialized when the derived endpoint is the Responses API.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VisionRequestOptions {
    pub thinking: bool,
    pub thinking_effort: ThinkingEffort,
    pub web_search: bool,
}

impl Default for VisionRequestOptions {
    fn default() -> Self {
        Self {
            thinking: false,
            thinking_effort: ThinkingEffort::Medium,
            web_search: false,
        }
    }
}

impl VisionRequestOptions {
    pub fn new(thinking: bool, thinking_effort: ThinkingEffort, web_search: bool) -> Self {
        Self {
            thinking,
            thinking_effort,
            web_search,
        }
    }
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisionCompletionResult {
    pub text: String,
    pub reasoning_summary: String,
    pub citations: Vec<VisionCitation>,
    /// A terminal provider status that accompanied a partial body. Callers may
    /// render `text` first and append this status without replacing it.
    pub error: Option<String>,
    pub incomplete_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisionCitation {
    pub title: String,
    pub url: String,
}

#[derive(Default)]
struct KeyRuntime {
    recent: HashMap<String, [u8; 32]>,
    cooling: HashMap<(String, [u8; 32]), Instant>,
}

struct StreamOutputBudget {
    bytes: usize,
    limit: usize,
}

impl Default for StreamOutputBudget {
    fn default() -> Self {
        Self {
            bytes: 0,
            limit: MAX_AI_OUTPUT_BYTES,
        }
    }
}

impl StreamOutputBudget {
    fn observe(&mut self, delta: &SseDelta) -> Result<(), String> {
        let additional = match delta {
            SseDelta::TextDelta { text, .. }
            | SseDelta::TextDone { text, .. }
            | SseDelta::TextForItemDelta { text, .. }
            | SseDelta::TextForItemDone { text, .. }
            | SseDelta::RefusalDelta { text, .. }
            | SseDelta::RefusalDone { text, .. }
            | SseDelta::Reasoning { text, .. }
            | SseDelta::ReasoningDone { text, .. } => text.len(),
            SseDelta::Citation { title, url, .. } => title.len().saturating_add(url.len()),
            SseDelta::ItemPhase { item_id, phase } => item_id.len().saturating_add(phase.len()),
            SseDelta::Error(message) => message.len(),
            SseDelta::ErrorWithReason { message, reason } => {
                message.len().saturating_add(reason.len())
            }
            SseDelta::Done => 0,
        };
        self.bytes = self.bytes.saturating_add(additional);
        if self.bytes > self.limit {
            Err(format!(
                "Provider output exceeds the {}-byte limit",
                self.limit
            ))
        } else {
            Ok(())
        }
    }
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
    complete_text_cancelled(provider, model, keys, system, user, policy, None).await
}

pub async fn complete_text_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
    cancellation: Option<Arc<CancellationSignal>>,
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
    send_completion_at_cancelled(
        provider,
        model,
        keys,
        body,
        endpoints.protocol,
        policy,
        endpoints.request,
        cancellation,
    )
    .await
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TextRequestOptions {
    pub thinking_effort: Option<ThinkingEffort>,
}

impl TextRequestOptions {
    pub fn new(thinking_effort: ThinkingEffort) -> Self {
        Self {
            thinking_effort: Some(thinking_effort),
        }
    }
}

pub async fn complete_text_with_options(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
    options: TextRequestOptions,
) -> Result<String, String> {
    complete_text_with_options_cancelled(provider, model, keys, system, user, policy, options, None)
        .await
}

#[allow(clippy::too_many_arguments)]
pub async fn complete_text_with_options_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
    options: TextRequestOptions,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<String, String> {
    let endpoints = derive_endpoints(&provider.base_url)?;
    let mut body = match endpoints.protocol {
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
    apply_text_options(&mut body, endpoints.protocol, options);
    send_completion_at_cancelled(
        provider,
        model,
        keys,
        body,
        endpoints.protocol,
        policy,
        endpoints.request,
        cancellation,
    )
    .await
}

pub async fn complete_text_with_effort(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
    thinking_effort: ThinkingEffort,
) -> Result<String, String> {
    complete_text_with_options(
        provider,
        model,
        keys,
        system,
        user,
        policy,
        TextRequestOptions::new(thinking_effort),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn complete_text_with_effort_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    user: &str,
    policy: AiRequestPolicy,
    thinking_effort: ThinkingEffort,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<String, String> {
    complete_text_with_options_cancelled(
        provider,
        model,
        keys,
        system,
        user,
        policy,
        TextRequestOptions::new(thinking_effort),
        cancellation,
    )
    .await
}

#[allow(dead_code)]
pub async fn complete_vision(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
) -> Result<String, String> {
    complete_vision_with_options(
        provider,
        model,
        keys,
        system,
        messages,
        image_url,
        policy,
        VisionRequestOptions::default(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn complete_vision_with_options(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
    options: VisionRequestOptions,
) -> Result<String, String> {
    complete_vision_with_options_result(
        provider, model, keys, system, messages, image_url, policy, options,
    )
    .await
    .and_then(|result| match result.error {
        Some(error) => Err(error),
        None => Ok(result.text),
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn complete_vision_with_options_result(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
    options: VisionRequestOptions,
) -> Result<VisionCompletionResult, String> {
    complete_vision_with_options_result_cancelled(
        provider, model, keys, system, messages, image_url, policy, options, None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn complete_vision_with_options_result_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
    options: VisionRequestOptions,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<VisionCompletionResult, String> {
    let (protocol, request_url, body) = build_vision_request(
        provider, model, system, messages, image_url, policy, options,
    )?;
    send_completion_result_at(
        provider,
        model,
        keys,
        body,
        protocol,
        policy,
        request_url,
        cancellation,
    )
    .await
}

fn build_vision_request(
    provider: &ProviderSettings,
    model: &str,
    system: &str,
    messages: &[AiMessage<'_>],
    image_url: Option<&str>,
    policy: AiRequestPolicy,
    options: VisionRequestOptions,
) -> Result<(ApiProtocol, Url, Value), String> {
    let endpoints = derive_endpoints(&provider.base_url)?;
    validate_vision_options(endpoints.protocol, options)?;
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
                let mut content = vec![json!({
                    "type": responses_text_type(message.role),
                    "text": message.content
                })];
                if Some(index) == last_user {
                    if let Some(url) = image_url {
                        content.push(json!({"type": "input_image", "image_url": url}));
                    }
                }
                values.push(json!({"role": message.role, "content": content}));
            }
            let mut body = json!({"model": model, "input": values, "stream": policy.stream});
            apply_responses_options(&mut body, options);
            body
        }
    };
    Ok((endpoints.protocol, endpoints.request, body))
}

#[allow(dead_code)]
pub async fn stream_vision<F, C>(
    input: VisionCompletion<'_>,
    on_delta: F,
    cancelled: C,
) -> Result<AiStreamFinish, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
    C: Fn() -> bool,
{
    stream_vision_with_options(input, on_delta, cancelled, VisionRequestOptions::default()).await
}

pub async fn stream_vision_with_options<F, C>(
    input: VisionCompletion<'_>,
    on_delta: F,
    cancelled: C,
    options: VisionRequestOptions,
) -> Result<AiStreamFinish, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
    C: Fn() -> bool,
{
    stream_vision_with_options_cancelled(input, on_delta, cancelled, options, None).await
}

pub async fn stream_vision_with_options_cancelled<F, C>(
    input: VisionCompletion<'_>,
    mut on_delta: F,
    cancelled: C,
    options: VisionRequestOptions,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<AiStreamFinish, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
    C: Fn() -> bool,
{
    if cancelled() {
        return Ok(AiStreamFinish::Cancelled);
    }
    let endpoints = derive_endpoints(&input.provider.base_url)?;
    validate_vision_options(endpoints.protocol, options)?;
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
                let mut content = vec![json!({
                    "type": responses_text_type(message.role),
                    "text": message.content
                })];
                if Some(index) == last_user {
                    if let Some(url) = input.image_url {
                        content.push(json!({"type": "input_image", "image_url": url}));
                    }
                }
                values.push(json!({"role": message.role, "content": content}));
            }
            let mut body = json!({"model": input.model, "input": values, "stream": true});
            apply_responses_options(&mut body, options);
            body
        }
    };
    let response = match request_with_failover_at_cancelled(
        input.provider,
        input.model,
        input.keys,
        &body,
        input.policy,
        endpoints.request,
        cancellation.clone(),
    )
    .await
    {
        Ok(response) => response,
        Err(RequestFailure::Cancelled) => return Ok(AiStreamFinish::Cancelled),
        Err(RequestFailure::Error(error)) => {
            return Err(redact_provider_message(&error, input.keys));
        }
    };
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut stream_bytes = 0usize;
    let mut output_budget = StreamOutputBudget::default();
    loop {
        let next = if let Some(signal) = cancellation.as_ref() {
            tokio::select! {
                next = async {
                    notify_client_phase!(signal, TestClientPhase::SseNext);
                    stream.next().await
                } => next,
                _ = signal.cancelled() => return Ok(AiStreamFinish::Cancelled),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        if cancelled() {
            return Ok(AiStreamFinish::Cancelled);
        }
        let chunk = chunk.map_err(|error| error.to_string())?;
        stream_bytes = stream_bytes.saturating_add(chunk.len());
        if stream_bytes > MAX_SSE_STREAM_BYTES {
            return Err(format!(
                "Provider stream exceeds the {MAX_SSE_STREAM_BYTES}-byte limit"
            ));
        }
        for event in decoder.push(&chunk)? {
            if cancelled() {
                return Ok(AiStreamFinish::Cancelled);
            }
            if consume_sse_event(&event, &mut on_delta, input.keys, &mut output_budget)
                .map_err(|error| redact_provider_message(&error, input.keys))?
            {
                return Ok(AiStreamFinish::Done);
            }
        }
    }
    for event in decoder.finish()? {
        if cancelled() {
            return Ok(AiStreamFinish::Cancelled);
        }
        if consume_sse_event(&event, &mut on_delta, input.keys, &mut output_budget)
            .map_err(|error| redact_provider_message(&error, input.keys))?
        {
            return Ok(AiStreamFinish::Done);
        }
    }
    if cancelled() {
        Ok(AiStreamFinish::Cancelled)
    } else {
        Err("Provider stream ended before completion".into())
    }
}

#[allow(clippy::too_many_arguments)]
async fn send_completion_at_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    body: Value,
    protocol: ApiProtocol,
    policy: AiRequestPolicy,
    request_url: Url,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<String, String> {
    let response = request_with_failover_at_cancelled(
        provider,
        model,
        keys,
        &body,
        policy,
        request_url,
        cancellation.clone(),
    )
    .await
    .map_err(|failure| failure.into_message(keys))?;
    if let Some(signal) = cancellation.as_ref() {
        notify_client_phase!(signal, TestClientPhase::ResponseJsonBody);
    }
    let value = read_json_limited::<Value>(
        response,
        MAX_AI_JSON_RESPONSE_BYTES,
        "Provider response",
        cancellation.as_deref(),
    )
    .await?;
    parse_completion(protocol, &value)
        .map(|result| result.text)
        .map_err(|error| redact_provider_message(&error, keys))
}

#[allow(clippy::too_many_arguments)]
async fn send_completion_result_at(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    body: Value,
    protocol: ApiProtocol,
    policy: AiRequestPolicy,
    request_url: Url,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<VisionCompletionResult, String> {
    let response = request_with_failover_at_cancelled(
        provider,
        model,
        keys,
        &body,
        policy,
        request_url,
        cancellation.clone(),
    )
    .await
    .map_err(|failure| failure.into_message(keys))?;
    if let Some(signal) = cancellation.as_ref() {
        notify_client_phase!(signal, TestClientPhase::ResponseJsonBody);
    }
    let value = read_json_limited::<Value>(
        response,
        MAX_AI_JSON_RESPONSE_BYTES,
        "Provider response",
        cancellation.as_deref(),
    )
    .await?;
    let mut result = parse_completion_partial(protocol, &value)
        .map_err(|error| redact_provider_message(&error, keys))?;
    result.error = result
        .error
        .map(|error| redact_provider_message(&error, keys));
    result.incomplete_reason = result
        .incomplete_reason
        .map(|reason| redact_provider_message(&reason, keys));
    Ok(result)
}

#[derive(Debug)]
enum RequestFailure {
    Cancelled,
    Error(String),
}

impl RequestFailure {
    fn into_message(self, keys: &[String]) -> String {
        match self {
            Self::Cancelled => "Request cancelled".into(),
            Self::Error(error) => redact_provider_message(&error, keys),
        }
    }
}

async fn request_with_failover_at_cancelled(
    provider: &ProviderSettings,
    model: &str,
    keys: &[String],
    body: &Value,
    policy: AiRequestPolicy,
    request_url: Url,
    cancellation: Option<Arc<CancellationSignal>>,
) -> Result<reqwest::Response, RequestFailure> {
    if model.trim().is_empty() {
        return Err(RequestFailure::Error("A model must be selected".into()));
    }
    if keys.is_empty() {
        return Err(RequestFailure::Error(
            "The selected provider has no API key".into(),
        ));
    }
    let identity = format!("{}|{}", provider.id, provider.base_url);
    let mut last_error = "Provider request failed".to_string();
    for attempt in 0..policy.attempts {
        if cancellation
            .as_ref()
            .is_some_and(|signal| signal.is_cancelled())
        {
            return Err(RequestFailure::Cancelled);
        }
        let mut retriable = false;
        let mut delay = exponential_backoff(attempt);
        for index in ordered_key_indices(&identity, keys, Instant::now()) {
            let key = &keys[index];
            let request = client()
                .map_err(RequestFailure::Error)?
                .post(request_url.clone())
                .bearer_auth(key)
                .json(body);
            let response = if let Some(signal) = cancellation.as_ref() {
                tokio::select! {
                    response = request.send() => response,
                    _ = signal.cancelled() => return Err(RequestFailure::Cancelled),
                }
            } else {
                request.send().await
            };
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
            if let Some(signal) = cancellation.as_ref() {
                notify_client_phase!(signal, TestClientPhase::ErrorBody);
            }
            let text = match read_text_limited(
                response,
                MAX_ERROR_BODY_BYTES,
                "Provider error response",
                cancellation.as_deref(),
            )
            .await
            {
                Ok(text) => text,
                Err(_)
                    if cancellation
                        .as_ref()
                        .is_some_and(|signal| signal.is_cancelled()) =>
                {
                    return Err(RequestFailure::Cancelled);
                }
                Err(_) => String::new(),
            };
            let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            last_error = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map_or_else(
                    || format!("Provider returned HTTP {status_code}"),
                    str::to_string,
                );
            last_error = redact_provider_message(&last_error, keys);
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
            return Err(RequestFailure::Error(last_error));
        }
        if !retriable || attempt + 1 >= policy.attempts {
            return Err(RequestFailure::Error(last_error));
        }
        if !delay.is_zero() {
            if let Some(signal) = cancellation.as_ref() {
                tokio::select! {
                    _ = async {
                        notify_client_phase!(signal, TestClientPhase::RetrySleep);
                        sleep(delay).await
                    } => {},
                    _ = signal.cancelled() => return Err(RequestFailure::Cancelled),
                }
            } else {
                sleep(delay).await;
            }
        }
    }
    Err(RequestFailure::Error(last_error))
}

fn consume_sse_event<F>(
    event: &str,
    on_delta: &mut F,
    keys: &[String],
    output_budget: &mut StreamOutputBudget,
) -> Result<bool, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
{
    for delta in parse_openai_event(event)? {
        output_budget.observe(&delta)?;
        match delta {
            SseDelta::Done => return Ok(true),
            SseDelta::Error(error) => {
                let safe = redact_provider_message(&error, keys);
                on_delta(SseDelta::Error(safe.clone()))?;
                return Err(safe);
            }
            SseDelta::ErrorWithReason { message, reason } => {
                let safe_message = redact_provider_message(&message, keys);
                let safe_reason = redact_provider_message(&reason, keys);
                on_delta(SseDelta::ErrorWithReason {
                    message: safe_message.clone(),
                    reason: safe_reason,
                })?;
                return Err(safe_message);
            }
            value => on_delta(value)?,
        }
    }
    Ok(false)
}

fn apply_text_options(body: &mut Value, protocol: ApiProtocol, options: TextRequestOptions) {
    let Some(effort) = options.thinking_effort else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    match protocol {
        ApiProtocol::ChatCompletions => {
            object.insert("reasoning_effort".into(), json!(reasoning_effort(effort)));
        }
        ApiProtocol::Responses => {
            object.insert(
                "reasoning".into(),
                json!({"effort": reasoning_effort(effort)}),
            );
        }
    }
}

fn apply_responses_options(body: &mut Value, options: VisionRequestOptions) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let mut reasoning = json!({
        "effort": reasoning_effort(options.thinking_effort),
    });
    if options.thinking {
        reasoning["summary"] = json!("auto");
    }
    object.insert("reasoning".into(), reasoning);
    if options.web_search {
        object.insert("tools".into(), json!([{ "type": "web_search" }]));
    }
}

fn validate_vision_options(
    protocol: ApiProtocol,
    options: VisionRequestOptions,
) -> Result<(), String> {
    if protocol == ApiProtocol::ChatCompletions && options.thinking {
        return Err(
            "This Chat Completions provider does not support Vision reasoning summaries; use a Responses endpoint or turn off 显示思考过程/摘要.".into(),
        );
    }
    if protocol == ApiProtocol::ChatCompletions && options.web_search {
        return Err(
            "This Chat Completions provider does not support Vision web search; use a Responses endpoint or turn off web search.".into(),
        );
    }
    Ok(())
}

fn responses_text_type(role: &str) -> &'static str {
    if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    }
}

fn reasoning_effort(effort: ThinkingEffort) -> &'static str {
    match effort {
        ThinkingEffort::Low => "low",
        ThinkingEffort::Medium => "medium",
        ThinkingEffort::High => "high",
        ThinkingEffort::Xhigh => "xhigh",
        ThinkingEffort::Max => "max",
    }
}

fn redact_provider_message(message: &str, keys: &[String]) -> String {
    keys.iter()
        .filter(|key| !key.is_empty())
        .fold(message.to_string(), |redacted, key| {
            redacted.replace(key, "[redacted]")
        })
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

fn parse_completion(
    protocol: ApiProtocol,
    value: &Value,
) -> Result<VisionCompletionResult, String> {
    if let Some(message) = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/response/error/message"))
        .and_then(Value::as_str)
    {
        return Err(message.to_string());
    }
    if matches!(
        value.get("status").and_then(Value::as_str),
        Some("failed" | "incomplete")
    ) || matches!(
        value.pointer("/response/status").and_then(Value::as_str),
        Some("failed" | "incomplete")
    ) {
        return Err(value
            .pointer("/response/error/message")
            .or_else(|| value.pointer("/error/message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                value
                    .pointer("/response/incomplete_details/reason")
                    .or_else(|| value.pointer("/incomplete_details/reason"))
                    .and_then(Value::as_str)
                    .map(|reason| format!("Provider response incomplete: {reason}"))
            })
            .unwrap_or_else(|| "Provider response did not complete".into()));
    }

    let (text, reasoning_summary, citations) = match protocol {
        ApiProtocol::ChatCompletions => {
            let finish_reason = value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str);
            if matches!(finish_reason, Some("length" | "content_filter")) {
                return Err(match finish_reason {
                    Some("length") => "Provider response was truncated".into(),
                    Some("content_filter") => {
                        "Provider response was blocked by the content filter".into()
                    }
                    _ => unreachable!(),
                });
            }
            let text = value
                .pointer("/choices/0/message/content")
                .and_then(|content| {
                    content.as_str().map(str::to_string).or_else(|| {
                        content.as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| part.get("text").and_then(Value::as_str))
                                .collect::<String>()
                        })
                    })
                })
                .or_else(|| {
                    value
                        .pointer("/choices/0/message/refusal")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            (text, String::new(), Vec::new())
        }
        ApiProtocol::Responses => {
            let output = value.get("output").and_then(Value::as_array);
            let has_phase = output.into_iter().flatten().any(|item| {
                item.get("phase")
                    .and_then(Value::as_str)
                    .is_some_and(|phase| !phase.is_empty())
                    || item
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .any(|content| {
                            content
                                .get("phase")
                                .and_then(Value::as_str)
                                .is_some_and(|phase| !phase.is_empty())
                        })
            });
            let mut text = output
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let commentary = has_phase
                        && item
                            .get("phase")
                            .and_then(Value::as_str)
                            .is_some_and(|phase| phase == "commentary");
                    (!commentary)
                        .then(|| item.get("content").and_then(Value::as_array))
                        .flatten()
                })
                .flatten()
                .filter(|content| {
                    matches!(
                        content.get("type").and_then(Value::as_str),
                        Some("output_text" | "refusal" | "output_refusal")
                    ) && (!has_phase
                        || content.get("phase").and_then(Value::as_str) != Some("commentary"))
                })
                .filter_map(|content| {
                    content
                        .get("text")
                        .or_else(|| content.get("refusal"))
                        .and_then(Value::as_str)
                })
                .collect::<String>();
            if text.is_empty() {
                text = value
                    .get("output_text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            if text.is_empty() {
                text = value
                    .get("refusal")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            let reasoning_summary = output
                .into_iter()
                .flatten()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
                .filter_map(|item| item.get("summary").and_then(Value::as_array))
                .flatten()
                .filter(|summary| {
                    summary.get("type").and_then(Value::as_str) == Some("summary_text")
                })
                .filter_map(|summary| summary.get("text").and_then(Value::as_str))
                .collect::<String>();
            let citations = output
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let commentary = has_phase
                        && item
                            .get("phase")
                            .and_then(Value::as_str)
                            .is_some_and(|phase| phase == "commentary");
                    (!commentary)
                        .then(|| item.get("content").and_then(Value::as_array))
                        .flatten()
                })
                .flatten()
                .filter(|content| {
                    !has_phase || content.get("phase").and_then(Value::as_str) != Some("commentary")
                })
                .flat_map(|content| {
                    content
                        .get("annotations")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|annotation| {
                    let title = annotation.get("title").and_then(Value::as_str)?;
                    let url = annotation.get("url").and_then(Value::as_str)?;
                    safe_citation_url(url).map(|url| VisionCitation {
                        title: title.to_string(),
                        url: url.to_string(),
                    })
                })
                .collect::<Vec<_>>();
            (text, reasoning_summary, citations)
        }
    };
    if text.trim().is_empty() {
        return Err("Provider returned an empty response".into());
    }
    Ok(VisionCompletionResult {
        text,
        reasoning_summary,
        citations,
        error: None,
        incomplete_reason: None,
    })
}

/// Parse a non-streaming response while retaining output that arrived with a
/// failed/incomplete terminal status. The strict parser above remains used by
/// ordinary text completions and tests; Vision callers use this lenient form so
/// a partial answer is never replaced by an error-only bubble.
fn parse_completion_partial(
    protocol: ApiProtocol,
    value: &Value,
) -> Result<VisionCompletionResult, String> {
    let terminal_error = completion_terminal_error(value);
    let incomplete_reason = value
        .pointer("/response/incomplete_details/reason")
        .or_else(|| value.pointer("/incomplete_details/reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut sanitized = value.clone();
    if let Some(object) = sanitized.as_object_mut() {
        object.remove("status");
        object.remove("error");
        if let Some(response) = object.get_mut("response").and_then(Value::as_object_mut) {
            response.remove("status");
            response.remove("error");
        }
        if let Some(choice) = object
            .get_mut("choices")
            .and_then(Value::as_array_mut)
            .and_then(|choices| choices.first_mut())
            .and_then(Value::as_object_mut)
        {
            if matches!(
                choice.get("finish_reason").and_then(Value::as_str),
                Some("length" | "content_filter")
            ) {
                choice.insert("finish_reason".into(), Value::String("stop".into()));
            }
        }
    }
    let mut result = match parse_completion(protocol, &sanitized) {
        Ok(result) => result,
        Err(_error) if terminal_error.is_some() => VisionCompletionResult {
            text: String::new(),
            reasoning_summary: String::new(),
            citations: Vec::new(),
            error: terminal_error.clone(),
            incomplete_reason: incomplete_reason.clone(),
        },
        Err(error) => return Err(error),
    };
    result.error = terminal_error;
    result.incomplete_reason = incomplete_reason;
    Ok(result)
}

fn completion_terminal_error(value: &Value) -> Option<String> {
    if let Some(message) = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/response/error/message"))
        .and_then(Value::as_str)
    {
        return Some(message.to_string());
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/response/status").and_then(Value::as_str));
    match status {
        Some("failed") => Some("Provider response failed".into()),
        Some("incomplete") => Some(
            value
                .pointer("/response/incomplete_details/reason")
                .or_else(|| value.pointer("/incomplete_details/reason"))
                .and_then(Value::as_str)
                .map(|reason| format!("Provider response incomplete: {reason}"))
                .unwrap_or_else(|| "Provider response was incomplete".into()),
        ),
        _ => match value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            Some("length") => Some("Provider response was truncated".into()),
            Some("content_filter") => {
                Some("Provider response was blocked by the content filter".into())
            }
            _ => None,
        },
    }
}

fn safe_citation_url(value: &str) -> Option<&str> {
    let url = Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::state::CancellationSignal;
    use crate::domain::settings::ThinkingEffort;
    use std::io::{Read as StdRead, Write as StdWrite};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::{Arc, Mutex as StdMutex};
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

    fn spawn_partial_http_server(
        content_type: &'static str,
        body: &'static [u8],
    ) -> (String, Receiver<()>, Receiver<()>, Arc<AtomicBool>) {
        spawn_partial_http_server_with_status("200 OK", content_type, body)
    }

    fn spawn_partial_http_error_server(
        content_type: &'static str,
        body: &'static [u8],
    ) -> (String, Receiver<()>, Receiver<()>, Arc<AtomicBool>) {
        spawn_partial_http_server_with_status("500 Internal Server Error", content_type, body)
    }

    fn spawn_partial_http_server_with_status(
        status: &'static str,
        content_type: &'static str,
        body: &'static [u8],
    ) -> (String, Receiver<()>, Receiver<()>, Arc<AtomicBool>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("server address");
        let (accepted_tx, accepted_rx) = channel();
        let (body_tx, body_rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut request = [0_u8; 4096];
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = stream.read(&mut request);
            let _ = accepted_tx.send(());
            let headers = if content_type == "text/event-stream" {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n"
                )
            } else {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                    body.len() + 100
                )
            };
            let _ = stream.write_all(headers.as_bytes());
            if content_type == "text/event-stream" {
                let _ = stream.write_all(format!("{:X}\r\n", body.len()).as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.write_all(b"\r\n");
            } else {
                let _ = stream.write_all(body);
            }
            let _ = body_tx.send(());
            while !stop_thread.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        (format!("http://{address}/v1"), accepted_rx, body_rx, stop)
    }

    #[test]
    fn non_codex_provider_base_urls_follow_derived_protocol() {
        let version_root = provider("https://proxy.example.com/v1".into());
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let (protocol, request, _) = build_vision_request(
            &version_root,
            "model:vision",
            "system",
            &messages,
            None,
            AiRequestPolicy::new(false, 1, false),
            VisionRequestOptions::default(),
        )
        .expect("version root request");
        assert_eq!(protocol, ApiProtocol::Responses);
        assert_eq!(request.as_str(), "https://proxy.example.com/v1/responses");

        let bare_chat = provider("https://proxy.example.com/chat/completions".into());
        let (protocol, request, _) = build_vision_request(
            &bare_chat,
            "model:vision",
            "system",
            &messages,
            None,
            AiRequestPolicy::new(false, 1, false),
            VisionRequestOptions::default(),
        )
        .expect("bare chat suffix request");
        assert_eq!(protocol, ApiProtocol::Responses);
        assert_eq!(request.as_str(), "https://proxy.example.com/responses");
    }

    #[test]
    fn parses_all_responses_text_and_summary_content_without_raw_reasoning() {
        let result = parse_completion(
            ApiProtocol::Responses,
            &json!({
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [
                        {"type": "summary_text", "text": "summary one"},
                        {"type": "summary_text", "text": " summary two"}
                    ], "content": [{"type": "reasoning_text", "text": "hidden"}]},
                    {"type": "message", "phase": "commentary", "content": [
                        {"type": "output_text", "text": "preamble", "annotations": [
                            {"type": "url_citation", "title": "Preamble", "url": "https://example.com/preamble"}
                        ]}
                    ]},
                    {"type": "message", "phase": "final_answer", "content": [
                        {"type": "output_text", "text": "first"},
                        {"type": "output_text", "text": " second", "annotations": [
                            {"type": "url_citation", "title": "Source", "url": "https://example.com/source"},
                            {"type": "url_citation", "title": "Unsafe", "url": "javascript:alert(1)"}
                        ]}
                    ]}
                ]
            }),
        )
        .expect("responses result");
        assert_eq!(result.text, "first second");
        assert_eq!(result.reasoning_summary, "summary one summary two");
        assert!(!result.reasoning_summary.contains("hidden"));
        assert_eq!(
            result.citations,
            vec![VisionCitation {
                title: "Source".into(),
                url: "https://example.com/source".into()
            }]
        );
    }

    #[test]
    fn maps_responses_assistant_history_to_output_text_items() {
        assert_eq!(responses_text_type("user"), "input_text");
        assert_eq!(responses_text_type("system"), "input_text");
        assert_eq!(responses_text_type("assistant"), "output_text");
    }

    #[test]
    fn rejects_nonstream_incomplete_and_chat_truncation_statuses() {
        assert_eq!(
            parse_completion(
                ApiProtocol::Responses,
                &json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}),
            )
            .unwrap_err(),
            "Provider response incomplete: max_output_tokens"
        );
        assert_eq!(
            parse_completion(
                ApiProtocol::ChatCompletions,
                &json!({"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]}),
            )
            .unwrap_err(),
            "Provider response was truncated"
        );
    }

    #[test]
    fn preserves_partial_responses_and_refusal_text() {
        let result = parse_completion_partial(
            ApiProtocol::Responses,
            &json!({
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [{"type": "message", "content": [
                    {"type": "output_text", "text": "partial"}
                ]}]
            }),
        )
        .expect("partial response");
        assert_eq!(result.text, "partial");
        assert_eq!(
            result.incomplete_reason.as_deref(),
            Some("max_output_tokens")
        );
        assert!(result.error.is_some());

        let failed = parse_completion_partial(
            ApiProtocol::Responses,
            &json!({
                "status": "failed",
                "error": {"message": "upstream failed"},
                "output": [{"content": [{"type": "output_text", "text": "kept"}]}]
            }),
        )
        .expect("failed response with partial output");
        assert_eq!(failed.text, "kept");
        assert_eq!(failed.error.as_deref(), Some("upstream failed"));

        let failed_without_output = parse_completion_partial(
            ApiProtocol::Responses,
            &json!({
                "status": "failed",
                "error": {"message": "upstream failed without output"}
            }),
        )
        .expect("error-only response should retain terminal status");
        assert!(failed_without_output.text.is_empty());
        assert_eq!(
            failed_without_output.error.as_deref(),
            Some("upstream failed without output")
        );

        let refusal = parse_completion(
            ApiProtocol::Responses,
            &json!({
                "output": [{"type": "message", "content": [
                    {"type": "refusal", "refusal": "I cannot comply"}
                ]}]
            }),
        )
        .expect("refusal text");
        assert_eq!(refusal.text, "I cannot comply");
    }

    #[test]
    fn redacts_all_configured_keys_before_terminal_stream_callbacks() {
        let keys = vec!["key-one".to_string(), "key-two".to_string()];
        let mut seen = Vec::new();
        let mut output_budget = StreamOutputBudget::default();
        let error = consume_sse_event(
            r#"{"error":{"message":"bad key-one and key-two"}}"#,
            &mut |delta| {
                seen.push(delta);
                Ok(())
            },
            &keys,
            &mut output_budget,
        )
        .expect_err("provider event should fail");
        assert!(!error.contains("key-one"));
        assert!(!error.contains("key-two"));
        assert!(matches!(
            seen.as_slice(),
            [SseDelta::Error(message)] if !message.contains("key-one") && !message.contains("key-two")
        ));
    }

    #[test]
    fn rejects_stream_output_that_exceeds_the_accumulated_budget() {
        let mut budget = StreamOutputBudget { bytes: 0, limit: 4 };
        budget
            .observe(&SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "four".into(),
            })
            .expect("output at the limit");
        assert_eq!(
            budget.observe(&SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "!".into(),
            }),
            Err("Provider output exceeds the 4-byte limit".into())
        );
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
            &provider(format!("{}/v1/chat/completions", server.uri())),
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
    async fn constructs_chat_optimizer_request_with_reasoning_effort() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer optimizer-chat-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "messages": [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "user"}
                ],
                "stream": false,
                "reasoning_effort": "max"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"content": "answer"}}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let answer = complete_text_with_effort(
            &provider(format!("{}/v1/chat/completions", server.uri())),
            "model:vision",
            &["optimizer-chat-secret".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
            ThinkingEffort::Max,
        )
        .await
        .expect("optimizer chat completion");
        assert_eq!(answer, "answer");
    }

    #[tokio::test]
    async fn constructs_responses_optimizer_request_with_reasoning_effort() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer optimizer-responses-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                    {"role": "user", "content": [{"type": "input_text", "text": "user"}]}
                ],
                "stream": false,
                "reasoning": {"effort": "max"}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [{"content": [{"type": "output_text", "text": "answer"}]}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let answer = complete_text_with_effort(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["optimizer-responses-secret".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
            ThinkingEffort::Max,
        )
        .await
        .expect("optimizer responses completion");
        assert_eq!(answer, "answer");
    }

    #[test]
    fn maps_max_reasoning_effort_to_provider_value() {
        assert_eq!(reasoning_effort(ThinkingEffort::Max), "max");
    }

    #[tokio::test]
    async fn constructs_responses_request_and_rotates_auth_key() {
        let server = MockServer::start().await;
        let ordinary_responses_body = json!({
            "model": "model:vision",
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                {"role": "user", "content": [{"type": "input_text", "text": "user"}]}
            ],
            "stream": false
        });
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer rejected"))
            .and(body_json(ordinary_responses_body.clone()))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"error": {"message": "bad key"}})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer working"))
            .and(body_json(ordinary_responses_body))
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

    #[tokio::test]
    async fn constructs_responses_vision_options_without_legacy_search_preview() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer vision-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                    {"role": "user", "content": [
                        {"type": "input_text", "text": "question"},
                        {"type": "input_image", "image_url": "data:image/png;base64,abc"}
                    ]}
                ],
                "stream": false,
                "reasoning": {"effort": "high", "summary": "auto"},
                "tools": [{"type": "web_search"}]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [{"content": [{"type": "output_text", "text": "answer"}]}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let answer = complete_vision_with_options(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["vision-secret".into()],
            "system",
            &[AiMessage {
                role: "user",
                content: "question",
            }],
            Some("data:image/png;base64,abc"),
            AiRequestPolicy::new(false, 1, false),
            VisionRequestOptions::new(true, ThinkingEffort::High, true),
        )
        .await
        .expect("vision completion");
        assert_eq!(answer, "answer");

        let disabled = Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer vision-secret-2"))
            .and(body_json(json!({
                "model": "model:vision",
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                    {"role": "user", "content": [{"type": "input_text", "text": "question"}]}
                ],
                "stream": false,
                "reasoning": {"effort": "medium"}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [{"content": [{"type": "output_text", "text": "answer-2"}]}]
            })))
            .expect(1);
        disabled.mount(&server).await;
        let answer = complete_vision_with_options(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["vision-secret-2".into()],
            "system",
            &[AiMessage {
                role: "user",
                content: "question",
            }],
            None,
            AiRequestPolicy::new(false, 1, false),
            VisionRequestOptions::default(),
        )
        .await
        .expect("vision completion without optional fields");
        assert_eq!(answer, "answer-2");
    }

    #[tokio::test]
    async fn constructs_responses_vision_max_reasoning_payload() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer vision-max-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                    {"role": "user", "content": [{"type": "input_text", "text": "question"}]}
                ],
                "stream": false,
                "reasoning": {"effort": "max", "summary": "auto"}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [{"content": [{"type": "output_text", "text": "answer"}]}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let answer = complete_vision_with_options(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["vision-max-secret".into()],
            "system",
            &[AiMessage {
                role: "user",
                content: "question",
            }],
            None,
            AiRequestPolicy::new(false, 1, false),
            VisionRequestOptions::new(true, ThinkingEffort::Max, false),
        )
        .await
        .expect("vision max completion");
        assert_eq!(answer, "answer");
    }

    #[tokio::test]
    async fn streams_responses_text_and_reasoning_summary_in_order() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer response-stream-secret"))
            .and(body_json(json!({
                "model": "model:vision",
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": "system"}]},
                    {"role": "user", "content": [{"type": "input_text", "text": "question"}]}
                ],
                "stream": true,
                "reasoning": {"effort": "medium", "summary": "auto"},
                "tools": [{"type": "web_search"}]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                concat!(
                    "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"summary\"}\r\n\r\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\r\n\r\n",
                    "data: {\"type\":\"response.completed\"}\r\n\r\n"
                ),
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let deltas = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&deltas);
        let finish = stream_vision_with_options(
            VisionCompletion {
                provider: &provider(format!("{}/v1/responses", server.uri())),
                model: "model:vision",
                keys: &["response-stream-secret".into()],
                system: "system",
                messages: &[AiMessage {
                    role: "user",
                    content: "question",
                }],
                image_url: None,
                policy: AiRequestPolicy::new(true, 3, true),
            },
            |delta| {
                captured.lock().expect("delta lock").push(delta);
                Ok(())
            },
            || false,
            VisionRequestOptions::new(true, ThinkingEffort::Medium, true),
        )
        .await
        .expect("response stream");
        assert_eq!(finish, AiStreamFinish::Done);
        assert_eq!(
            *deltas.lock().expect("delta lock"),
            vec![
                SseDelta::Reasoning {
                    item_id: None,
                    summary_index: None,
                    text: "summary".into()
                },
                SseDelta::TextDelta {
                    item_id: None,
                    content_index: None,
                    text: "answer".into()
                }
            ]
        );
    }

    #[tokio::test]
    async fn cancellation_stops_processing_events_after_partial_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                concat!(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"late\"}\n\n",
                    "data: {\"type\":\"response.completed\"}\n\n"
                ),
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_callback = Arc::clone(&cancelled);
        let deltas = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&deltas);
        let finish = stream_vision_with_options(
            VisionCompletion {
                provider: &provider(format!("{}/v1/responses", server.uri())),
                model: "model:vision",
                keys: &["cancel-secret".into()],
                system: "system",
                messages: &[AiMessage {
                    role: "user",
                    content: "question",
                }],
                image_url: None,
                policy: AiRequestPolicy::new(false, 1, true),
            },
            |delta| {
                captured.lock().expect("delta lock").push(delta);
                cancelled_for_callback.store(true, Ordering::SeqCst);
                Ok(())
            },
            || cancelled.load(Ordering::SeqCst),
            VisionRequestOptions::default(),
        )
        .await
        .expect("cancelled stream");
        assert_eq!(finish, AiStreamFinish::Cancelled);
        assert_eq!(
            *deltas.lock().expect("delta lock"),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "first".into()
            }]
        );
    }

    #[tokio::test]
    async fn cancellation_wakes_an_inflight_headers_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(5))
                    .set_body_raw("data: [DONE]\n\n", "text/event-stream"),
            )
            .mount(&server)
            .await;
        let signal = Arc::new(CancellationSignal::new());
        let test_provider = provider(format!("{}/v1/responses", server.uri()));
        let keys = vec!["cancel-wakeup-secret".to_string()];
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            stream_vision_with_options_cancelled(
                VisionCompletion {
                    provider: &test_provider,
                    model: "model:vision",
                    keys: &keys,
                    system: "system",
                    messages: &messages,
                    image_url: None,
                    policy: AiRequestPolicy::new(false, 1, true),
                },
                |_| Ok(()),
                || false,
                VisionRequestOptions::default(),
                Some(task_signal),
            )
            .await
        });
        for _ in 0..100 {
            if server
                .received_requests()
                .await
                .is_some_and(|requests| !requests.is_empty())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(server
            .received_requests()
            .await
            .is_some_and(|requests| !requests.is_empty()));
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("cancellation should wake request")
            .expect("worker join");
        assert_eq!(result.expect("stream result"), AiStreamFinish::Cancelled);
    }

    #[tokio::test]
    async fn cancellation_wakes_retry_backoff_without_waiting_for_delay() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("retry-after", "30")
                    .set_body_json(json!({"error": {"message": "busy"}})),
            )
            .mount(&server)
            .await;
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{}/v1/responses", server.uri()));
        let keys = vec!["retry-cancel-secret".to_string()];
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            stream_vision_with_options_cancelled(
                VisionCompletion {
                    provider: &test_provider,
                    model: "model:vision",
                    keys: &keys,
                    system: "system",
                    messages: &messages,
                    image_url: None,
                    policy: AiRequestPolicy::new(true, 3, true),
                },
                |_| Ok(()),
                || false,
                VisionRequestOptions::default(),
                Some(task_signal),
            )
            .await
        });
        wait_test_client_phase(&observer, TestClientPhase::RetrySleep).await;
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("retry cancellation should wake")
            .expect("worker join");
        assert_eq!(result.expect("stream result"), AiStreamFinish::Cancelled);
    }

    #[tokio::test]
    async fn cancellation_wakes_idle_sse_body_after_headers_and_first_chunk() {
        let (base_url, _accepted, _body_sent, stop) = spawn_partial_http_server(
            "text/event-stream",
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
        );
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{base_url}/responses"));
        let keys = vec!["idle-sse-secret".to_string()];
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let captured_task = Arc::clone(&captured);
        let delta_ready = Arc::new(Notify::new());
        let delta_ready_task = Arc::clone(&delta_ready);
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            stream_vision_with_options_cancelled(
                VisionCompletion {
                    provider: &test_provider,
                    model: "model:vision",
                    keys: &keys,
                    system: "system",
                    messages: &messages,
                    image_url: None,
                    policy: AiRequestPolicy::new(false, 1, true),
                },
                |delta| {
                    captured_task.lock().expect("capture lock").push(delta);
                    delta_ready_task.notify_waiters();
                    Ok(())
                },
                || false,
                VisionRequestOptions::default(),
                Some(task_signal),
            )
            .await
        });
        // The first phase is the initial read. Wait for the callback, then
        // wait for the second `stream.next()` phase so cancellation targets
        // an idle body read rather than headers.
        wait_test_client_phase(&observer, TestClientPhase::SseNext).await;
        let notified = delta_ready.notified();
        if captured.lock().expect("capture lock").is_empty() {
            notified.await;
        }
        wait_test_client_phase(&observer, TestClientPhase::SseNext).await;
        assert!(!captured.lock().expect("capture lock").is_empty());
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("idle SSE cancellation should wake")
            .expect("worker join");
        stop.store(true, Ordering::SeqCst);
        assert_eq!(result.expect("stream result"), AiStreamFinish::Cancelled);
        assert!(!captured.lock().expect("capture lock").is_empty());
    }

    #[tokio::test]
    async fn cancellation_wakes_nonstream_json_body_after_headers() {
        let (base_url, _accepted, _body_sent, stop) = spawn_partial_http_server(
            "application/json",
            br#"{"output":[{"content":[{"type":"output_text","text":"partial"}]}]}"#,
        );
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{base_url}/responses"));
        let keys = vec!["json-body-secret".to_string()];
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            complete_vision_with_options_result_cancelled(
                &test_provider,
                "model:vision",
                &keys,
                "system",
                &messages,
                None,
                AiRequestPolicy::new(false, 1, false),
                VisionRequestOptions::default(),
                Some(task_signal),
            )
            .await
        });
        wait_test_client_phase(&observer, TestClientPhase::ResponseJsonBody).await;
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("JSON body cancellation should wake")
            .expect("worker join");
        stop.store(true, Ordering::SeqCst);
        assert_eq!(
            result.expect_err("body read should cancel"),
            "Request cancelled"
        );
    }

    #[tokio::test]
    async fn text_completion_cancellation_wakes_an_idle_response_body() {
        let (base_url, _accepted, _body_sent, stop) = spawn_partial_http_server(
            "application/json",
            br#"{"output":[{"content":[{"type":"output_text","text":"partial"}]}]}"#,
        );
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{base_url}/responses"));
        let keys = vec!["text-cancel-secret".to_string()];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            complete_text_cancelled(
                &test_provider,
                "model:text",
                &keys,
                "system",
                "user",
                AiRequestPolicy::new(false, 1, false),
                Some(task_signal),
            )
            .await
        });

        wait_test_client_phase(&observer, TestClientPhase::ResponseJsonBody).await;
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("text body cancellation should wake")
            .expect("worker join");
        stop.store(true, Ordering::SeqCst);
        assert_eq!(
            result.expect_err("text response body should cancel"),
            "Request cancelled"
        );
    }

    #[tokio::test]
    async fn optimizer_completion_with_effort_cancellation_wakes_an_idle_response_body() {
        let (base_url, _accepted, _body_sent, stop) = spawn_partial_http_server(
            "application/json",
            br#"{"output":[{"content":[{"type":"output_text","text":"partial"}]}]}"#,
        );
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{base_url}/responses"));
        let keys = vec!["optimizer-cancel-secret".to_string()];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            complete_text_with_effort_cancelled(
                &test_provider,
                "model:text",
                &keys,
                "system",
                "user",
                AiRequestPolicy::new(false, 1, false),
                ThinkingEffort::Max,
                Some(task_signal),
            )
            .await
        });

        wait_test_client_phase(&observer, TestClientPhase::ResponseJsonBody).await;
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("optimizer body cancellation should wake")
            .expect("worker join");
        stop.store(true, Ordering::SeqCst);
        assert_eq!(
            result.expect_err("optimizer response body should cancel"),
            "Request cancelled"
        );
    }

    #[tokio::test]
    async fn cancellation_wakes_delayed_non_success_error_body() {
        let (base_url, accepted, body_sent, stop) = spawn_partial_http_error_server(
            "application/json",
            br#"{"error":{"message":"upstream is still writing"}}"#,
        );
        let signal = Arc::new(CancellationSignal::new());
        let observer = new_test_client_phase_observer(&signal);
        let test_provider = provider(format!("{base_url}/responses"));
        let keys = vec!["error-body-secret".to_string()];
        let messages = [AiMessage {
            role: "user",
            content: "question",
        }];
        let task_signal = Arc::clone(&signal);
        let worker = tokio::spawn(async move {
            complete_vision_with_options_result_cancelled(
                &test_provider,
                "model:vision",
                &keys,
                "system",
                &messages,
                None,
                AiRequestPolicy::new(false, 1, false),
                VisionRequestOptions::default(),
                Some(task_signal),
            )
            .await
        });
        assert!(tokio::task::spawn_blocking(move || {
            accepted.recv_timeout(Duration::from_secs(1)).is_ok()
        })
        .await
        .expect("accepted milestone task"));
        assert!(tokio::task::spawn_blocking(move || {
            body_sent.recv_timeout(Duration::from_secs(1)).is_ok()
        })
        .await
        .expect("body milestone task"));
        wait_test_client_phase(&observer, TestClientPhase::ErrorBody).await;
        signal.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("error body cancellation should wake")
            .expect("worker join");
        stop.store(true, Ordering::SeqCst);
        assert_eq!(
            result.expect_err("delayed error body should cancel"),
            "Request cancelled"
        );
    }

    #[tokio::test]
    async fn stream_eof_without_terminal_event_is_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let error = stream_vision_with_options(
            VisionCompletion {
                provider: &provider(format!("{}/v1/responses", server.uri())),
                model: "model:vision",
                keys: &["eof-secret".into()],
                system: "system",
                messages: &[AiMessage {
                    role: "user",
                    content: "question",
                }],
                image_url: None,
                policy: AiRequestPolicy::new(false, 1, true),
            },
            |_| Ok(()),
            || false,
            VisionRequestOptions::default(),
        )
        .await
        .expect_err("missing response.completed should fail");
        assert_eq!(error, "Provider stream ended before completion");
    }

    #[tokio::test]
    async fn provider_errors_redact_api_keys() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer response-secret"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": {"message": "invalid key response-secret"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let error = complete_text(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["response-secret".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
        )
        .await
        .expect_err("provider failure");
        assert!(!error.contains("response-secret"));
        assert!(error.contains("[redacted]"));

        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer response-secret-200"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "error": {"message": "semantic failure response-secret-200"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let error = complete_text(
            &provider(format!("{}/v1/responses", server.uri())),
            "model:vision",
            &["response-secret-200".into()],
            "system",
            "user",
            AiRequestPolicy::new(false, 1, false),
        )
        .await
        .expect_err("semantic provider failure");
        assert!(!error.contains("response-secret-200"));
        assert!(error.contains("[redacted]"));
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
    async fn streams_chat_text_and_done_events_without_raw_reasoning() {
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
                provider: &provider(format!("{}/v1/chat/completions", server.uri())),
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
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "answer".into()
            }]
        );
    }
}
