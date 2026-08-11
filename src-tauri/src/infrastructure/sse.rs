use crate::infrastructure::provider_http::MAX_SSE_EVENT_BYTES;
use serde_json::Value;
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SseDelta {
    /// A true streaming fragment. Consumers append this exactly as received.
    TextDelta {
        item_id: Option<String>,
        content_index: Option<usize>,
        text: String,
    },
    /// A full-text snapshot from a `*.done` event. Consumers use it only as a
    /// fallback when no corresponding delta was observed.
    TextDone {
        item_id: Option<String>,
        content_index: Option<usize>,
        text: String,
    },
    TextForItemDelta {
        item_id: String,
        content_index: Option<usize>,
        text: String,
    },
    TextForItemDone {
        item_id: String,
        content_index: Option<usize>,
        text: String,
    },
    RefusalDelta {
        item_id: Option<String>,
        content_index: Option<usize>,
        text: String,
    },
    RefusalDone {
        item_id: Option<String>,
        content_index: Option<usize>,
        text: String,
    },
    Reasoning {
        item_id: Option<String>,
        summary_index: Option<usize>,
        text: String,
    },
    ReasoningDone {
        item_id: Option<String>,
        summary_index: Option<usize>,
        text: String,
    },
    Citation {
        item_id: Option<String>,
        title: String,
        url: String,
    },
    ItemPhase {
        item_id: String,
        phase: String,
    },
    Done,
    Error(String),
    ErrorWithReason {
        message: String,
        reason: String,
    },
}

pub struct SseDecoder {
    pending: Vec<u8>,
    max_event_bytes: usize,
}

impl Default for SseDecoder {
    fn default() -> Self {
        Self {
            pending: Vec::new(),
            max_event_bytes: MAX_SSE_EVENT_BYTES,
        }
    }
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((end, delimiter)) = event_boundary(&self.pending) {
            if end > self.max_event_bytes {
                return Err(format!(
                    "Provider stream event exceeds the {}-byte limit",
                    self.max_event_bytes
                ));
            }
            let event = self.pending.drain(..end).collect::<Vec<_>>();
            self.pending.drain(..delimiter);
            if let Some(data) = decode_event(&event)? {
                events.push(data);
            }
        }
        if self.pending.len() > self.max_event_bytes {
            return Err(format!(
                "Provider stream event exceeds the {}-byte limit",
                self.max_event_bytes
            ));
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, String> {
        if self.pending.iter().all(u8::is_ascii_whitespace) {
            self.pending.clear();
            return Ok(Vec::new());
        }
        if self.pending.len() > self.max_event_bytes {
            return Err(format!(
                "Provider stream event exceeds the {}-byte limit",
                self.max_event_bytes
            ));
        }
        let event = std::mem::take(&mut self.pending);
        Ok(decode_event(&event)?.into_iter().collect())
    }
}

pub fn parse_openai_event(data: &str) -> Result<Vec<SseDelta>, String> {
    if data.trim() == "[DONE]" {
        return Ok(vec![SseDelta::Done]);
    }
    let value = serde_json::from_str::<Value>(data)
        .map_err(|error| format!("Provider stream event is invalid: {error}"))?;
    let event_type = value.get("type").and_then(Value::as_str);
    if !matches!(event_type, Some("response.failed" | "response.incomplete")) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .pointer("/response/error/message")
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                (value.get("type").and_then(Value::as_str) == Some("error"))
                    .then(|| value.get("message").and_then(Value::as_str))
                    .flatten()
            })
        {
            return Ok(vec![SseDelta::Error(message.to_string())]);
        }
    }
    if matches!(event_type, Some("response.completed" | "response.done")) {
        let mut deltas = embedded_response_output(&value);
        deltas.push(SseDelta::Done);
        return Ok(deltas);
    }
    if matches!(event_type, Some("response.failed" | "response.incomplete")) {
        let message = value
            .pointer("/response/error/message")
            .or_else(|| value.pointer("/error/message"))
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                value
                    .pointer("/response/incomplete_details/reason")
                    .or_else(|| value.pointer("/incomplete_details/reason"))
                    .and_then(Value::as_str)
                    .map(|reason| format!("reason: {reason}"))
            })
            .unwrap_or_else(|| {
                if event_type == Some("response.incomplete") {
                    "Provider response was incomplete".into()
                } else {
                    "Provider response failed".into()
                }
            });
        if event_type == Some("response.incomplete") {
            let reason = value
                .pointer("/response/incomplete_details/reason")
                .or_else(|| value.pointer("/incomplete_details/reason"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let mut deltas = embedded_response_output(&value);
            deltas.push(SseDelta::ErrorWithReason { message, reason });
            return Ok(deltas);
        }
        let mut deltas = embedded_response_output(&value);
        deltas.push(SseDelta::Error(message));
        return Ok(deltas);
    }
    if matches!(
        event_type,
        Some("response.output_item.added" | "response.output_item.done")
    ) {
        let item = value.get("item");
        let item_id = item
            .and_then(|item| item.get("id"))
            .or_else(|| value.get("item_id"))
            .and_then(Value::as_str);
        let phase = item
            .and_then(|item| item.get("phase"))
            .or_else(|| value.get("phase"))
            .and_then(Value::as_str);
        let content_phase = item
            .and_then(|item| item.get("content"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find_map(|content| content.get("phase").and_then(Value::as_str));
        let phase = phase.or(content_phase);
        let mut deltas = Vec::new();
        if let (Some(item_id), Some(phase)) = (item_id, phase) {
            deltas.push(SseDelta::ItemPhase {
                item_id: item_id.to_string(),
                phase: phase.to_string(),
            });
        }
        if event_type == Some("response.output_item.done") {
            if item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("reasoning")
            {
                if let Some(summary) = item
                    .and_then(|item| item.get("summary"))
                    .and_then(Value::as_array)
                {
                    for (summary_index, text) in
                        summary.iter().enumerate().filter_map(|(index, part)| {
                            part.get("text")
                                .and_then(Value::as_str)
                                .filter(|text| !text.is_empty())
                                .map(|text| (index, text))
                        })
                    {
                        deltas.push(SseDelta::ReasoningDone {
                            item_id: item_id.map(str::to_string),
                            summary_index: Some(summary_index),
                            text: text.to_string(),
                        });
                    }
                }
            }
            if let (Some(item_id), Some(content)) = (
                item_id,
                item.and_then(|item| item.get("content"))
                    .and_then(Value::as_array),
            ) {
                for (content_index, text) in
                    content.iter().enumerate().filter_map(|(index, content)| {
                        (content.get("type").and_then(Value::as_str) == Some("output_text"))
                            .then(|| content.get("text").and_then(Value::as_str))
                            .flatten()
                            .filter(|text| !text.is_empty())
                            .map(|text| (index, text))
                    })
                {
                    deltas.push(SseDelta::TextForItemDone {
                        item_id: item_id.to_string(),
                        content_index: Some(content_index),
                        text: text.to_string(),
                    });
                }
                for (content_index, text) in
                    content.iter().enumerate().filter_map(|(index, content)| {
                        matches!(
                            content.get("type").and_then(Value::as_str),
                            Some("refusal" | "output_refusal")
                        )
                        .then(|| {
                            content
                                .get("refusal")
                                .or_else(|| content.get("text"))
                                .and_then(Value::as_str)
                        })
                        .flatten()
                        .filter(|text| !text.is_empty())
                        .map(|text| (index, text))
                    })
                {
                    deltas.push(SseDelta::RefusalDone {
                        item_id: Some(item_id.to_string()),
                        content_index: Some(content_index),
                        text: text.to_string(),
                    });
                }
            }
        }
        return Ok(deltas);
    }
    if matches!(
        event_type,
        Some(
            "response.output_text.delta"
                | "response.content_part.delta"
                | "response.output_text.done"
                | "response.content_part.done"
        )
    ) {
        let Some(text) = value
            .get("delta")
            .or_else(|| value.get("text"))
            .or_else(|| value.pointer("/part/text"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        else {
            return Ok(Vec::new());
        };
        let done = matches!(
            event_type,
            Some("response.output_text.done" | "response.content_part.done")
        );
        let item_id = value.get("item_id").and_then(Value::as_str);
        let content_index = event_index(&value, "content_index");
        return Ok(value
            .get("item_id")
            .and_then(Value::as_str)
            .map(|item_id| {
                vec![if done {
                    SseDelta::TextForItemDone {
                        item_id: item_id.to_string(),
                        content_index,
                        text: text.to_string(),
                    }
                } else {
                    SseDelta::TextForItemDelta {
                        item_id: item_id.to_string(),
                        content_index,
                        text: text.to_string(),
                    }
                }]
            })
            .unwrap_or_else(|| {
                vec![if done {
                    SseDelta::TextDone {
                        item_id: item_id.map(str::to_string),
                        content_index,
                        text: text.to_string(),
                    }
                } else {
                    SseDelta::TextDelta {
                        item_id: item_id.map(str::to_string),
                        content_index,
                        text: text.to_string(),
                    }
                }]
            }));
    }
    if matches!(
        event_type,
        Some("response.refusal.delta" | "response.refusal.done")
    ) {
        let text = value
            .get("delta")
            .or_else(|| value.get("refusal"))
            .or_else(|| value.get("text"))
            .or_else(|| value.pointer("/part/refusal"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        let Some(text) = text else {
            return Ok(Vec::new());
        };
        let item_id = value
            .get("item_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let content_index = event_index(&value, "content_index");
        return Ok(vec![if event_type == Some("response.refusal.done") {
            SseDelta::RefusalDone {
                item_id,
                content_index,
                text: text.to_string(),
            }
        } else {
            SseDelta::RefusalDelta {
                item_id,
                content_index,
                text: text.to_string(),
            }
        }]);
    }
    if matches!(
        event_type,
        Some("response.reasoning_summary_text.delta" | "response.reasoning_summary_text.done")
    ) {
        let done = event_type == Some("response.reasoning_summary_text.done");
        let item_id = value
            .get("item_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let summary_index = event_index(&value, "summary_index");
        return Ok(value
            .get("delta")
            .or_else(|| value.get("text"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| {
                vec![if done {
                    SseDelta::ReasoningDone {
                        item_id,
                        summary_index,
                        text: text.to_string(),
                    }
                } else {
                    SseDelta::Reasoning {
                        item_id,
                        summary_index,
                        text: text.to_string(),
                    }
                }]
            })
            .unwrap_or_default());
    }
    if event_type == Some("response.output_text.annotation.added") {
        let annotation = value.get("annotation").or_else(|| {
            value
                .get("annotations")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
        });
        if let Some(annotation) = annotation {
            let url = annotation.get("url").and_then(Value::as_str).filter(|url| {
                !url.is_empty()
                    && Url::parse(url)
                        .ok()
                        .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
            });
            let title = annotation
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty());
            if let (Some(url), Some(title)) = (url, title) {
                return Ok(vec![SseDelta::Citation {
                    item_id: value
                        .get("item_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    title: title.to_string(),
                    url: url.to_string(),
                }]);
            }
        }
    }
    let mut deltas = Vec::new();
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        deltas.push(SseDelta::TextDelta {
            item_id: None,
            content_index: None,
            text: text.to_string(),
        });
    }
    if let Some(refusal) = value
        .pointer("/choices/0/delta/refusal")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        deltas.push(SseDelta::RefusalDelta {
            item_id: None,
            content_index: None,
            text: refusal.to_string(),
        });
    }
    if let Some(reason) = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
    {
        match reason {
            "stop" | "tool_calls" => deltas.push(SseDelta::Done),
            "length" => deltas.push(SseDelta::Error("Provider response was truncated".into())),
            "content_filter" => deltas.push(SseDelta::Error(
                "Provider response was blocked by the content filter".into(),
            )),
            _ => deltas.push(SseDelta::Error(format!(
                "Provider stream ended with finish reason: {reason}"
            ))),
        }
    }
    Ok(deltas)
}

/// Some Responses-compatible gateways omit the incremental output events and
/// embed the final `response.output` inside `response.completed`. Surface that
/// output as done snapshots; the command-side item ledger guarantees exact-once
/// fallback when deltas were already observed.
fn embedded_response_output(value: &Value) -> Vec<SseDelta> {
    let response = value.get("response").unwrap_or(value);
    let Some(output) = response.get("output").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut deltas = Vec::new();
    for item in output {
        let item_id = item.get("id").and_then(Value::as_str);
        if item.get("type").and_then(Value::as_str) == Some("reasoning") {
            if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                for (summary_index, part) in summary.iter().enumerate() {
                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        deltas.push(SseDelta::ReasoningDone {
                            item_id: item.get("id").and_then(Value::as_str).map(str::to_string),
                            summary_index: Some(summary_index),
                            text: text.to_string(),
                        });
                    }
                }
            }
        }
        if let (Some(item_id), Some(phase)) = (
            item_id,
            item.get("phase").and_then(Value::as_str).or_else(|| {
                item.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find_map(|content| content.get("phase").and_then(Value::as_str))
            }),
        ) {
            deltas.push(SseDelta::ItemPhase {
                item_id: item_id.to_string(),
                phase: phase.to_string(),
            });
        }
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for (content_index, part) in content.iter().enumerate() {
            let part_type = part.get("type").and_then(Value::as_str);
            let text = part
                .get("text")
                .or_else(|| part.get("refusal"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            let Some(text) = text else { continue };
            match part_type {
                Some("output_text") => {
                    if let Some(item_id) = item_id {
                        deltas.push(SseDelta::TextForItemDone {
                            item_id: item_id.to_string(),
                            content_index: Some(content_index),
                            text: text.to_string(),
                        });
                    } else {
                        deltas.push(SseDelta::TextDone {
                            item_id: None,
                            content_index: Some(content_index),
                            text: text.to_string(),
                        });
                    }
                }
                Some("refusal" | "output_refusal") => {
                    deltas.push(SseDelta::RefusalDone {
                        item_id: item_id.map(str::to_string),
                        content_index: Some(content_index),
                        text: text.to_string(),
                    });
                }
                _ => {}
            }
            if let Some(annotations) = part.get("annotations").and_then(Value::as_array) {
                for annotation in annotations {
                    let Some(title) = annotation.get("title").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(url) = annotation.get("url").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(url) = safe_http_url(url) else {
                        continue;
                    };
                    deltas.push(SseDelta::Citation {
                        item_id: item_id.map(str::to_string),
                        title: title.to_string(),
                        url,
                    });
                }
            }
        }
    }
    deltas
}

fn safe_http_url(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| value.to_string())
}

fn event_index(value: &Value, field: &str) -> Option<usize> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
}

fn event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let crlf = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (position, 4));
    let lf = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2));
    match (crlf, lf) {
        (Some(first), Some(second)) => Some(if first.0 <= second.0 { first } else { second }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

fn decode_event(bytes: &[u8]) -> Result<Option<String>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("Provider stream is not valid UTF-8: {error}"))?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    Ok((!data.is_empty()).then_some(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_partial_lines_and_multibyte_events() {
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"")
            .unwrap()
            .is_empty());
        let mut suffix = "你好\"},\"finish_reason\":null}]}\n\n".as_bytes().to_vec();
        let tail = suffix.split_off(2);
        assert!(decoder.push(&suffix).unwrap().is_empty());
        let events = decoder.push(&tail).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            parse_openai_event(&events[0]).unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "你好".into()
            }]
        );
    }

    #[test]
    fn parses_chat_responses_done_and_errors() {
        assert_eq!(parse_openai_event("[DONE]").unwrap(), vec![SseDelta::Done]);
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.delta","delta":"answer"}"#)
                .unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "answer".into()
            }]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#
            )
            .unwrap(),
            vec![SseDelta::Reasoning {
                item_id: None,
                summary_index: None,
                text: "thinking".into()
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"error":{"message":"denied"}}"#).unwrap(),
            vec![SseDelta::Error("denied".into())]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.failed","response":{"error":{"message":"upstream failed"}}}"#
            )
            .unwrap(),
            vec![SseDelta::Error("upstream failed".into())]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#
            )
            .unwrap(),
            vec![SseDelta::ErrorWithReason {
                message: "reason: max_output_tokens".into(),
                reason: "max_output_tokens".into(),
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#).unwrap(),
            vec![SseDelta::Error("Provider response was truncated".into())]
        );
        assert_eq!(
            parse_openai_event(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap(),
            vec![SseDelta::Done]
        );
        assert!(parse_openai_event(
            r#"{"choices":[{"delta":{"reasoning_content":"raw chain of thought"},"finish_reason":null}]}"#
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.output_text.annotation.added","item_id":"msg_1","annotation":{"type":"url_citation","title":"Source","url":"https://example.com"}}"#
            )
            .unwrap(),
            vec![SseDelta::Citation {
                item_id: Some("msg_1".into()),
                title: "Source".into(),
                url: "https://example.com".into()
            }]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.output_item.added","item":{"id":"msg_1","type":"message","phase":"commentary"}}"#
            )
            .unwrap(),
            vec![SseDelta::ItemPhase {
                item_id: "msg_1".into(),
                phase: "commentary".into()
            }]
        );
        assert!(parse_openai_event(
            r#"{"type":"response.output_text.delta","item_id":"msg_1","phase":"commentary","delta":"preamble"}"#
        )
        .unwrap()
        .len()
            == 1);
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.output_item.done","item":{"id":"msg_2","type":"message","phase":"final_answer","content":[{"type":"output_text","text":"answer"}]}}"#
            )
            .unwrap(),
            vec![
                SseDelta::ItemPhase {
                    item_id: "msg_2".into(),
                    phase: "final_answer".into()
                },
                SseDelta::TextForItemDone {
                    item_id: "msg_2".into(),
                    content_index: Some(0),
                    text: "answer".into()
                }
            ]
        );
    }

    #[test]
    fn keeps_delta_and_done_snapshots_distinct_without_prefix_guessing() {
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.delta","delta":"a"}"#).unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "a".into()
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.delta","delta":"apple"}"#).unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "apple".into()
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.delta","delta":"apple"}"#).unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "apple".into()
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.done","text":"apple"}"#).unwrap(),
            vec![SseDelta::TextDone {
                item_id: None,
                content_index: None,
                text: "apple".into()
            }]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.output_text.done","item_id":"m","content_index":2,"text":"apple"}"#
            )
            .unwrap(),
            vec![SseDelta::TextForItemDone {
                item_id: "m".into(),
                content_index: Some(2),
                text: "apple".into()
            }]
        );
    }

    #[test]
    fn parses_refusal_delta_and_done_text() {
        assert_eq!(
            parse_openai_event(r#"{"type":"response.refusal.delta","delta":"no"}"#).unwrap(),
            vec![SseDelta::RefusalDelta {
                item_id: None,
                content_index: None,
                text: "no".into()
            }]
        );
        assert_eq!(
            parse_openai_event(r#"{"type":"response.refusal.done","refusal":"cannot"}"#).unwrap(),
            vec![SseDelta::RefusalDone {
                item_id: None,
                content_index: None,
                text: "cannot".into()
            }]
        );
    }

    #[test]
    fn extracts_embedded_completed_output_as_done_fallback_before_terminal_done() {
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.completed","response":{"output":[{"id":"m","phase":"final_answer","content":[{"type":"output_text","text":"answer"}]}]}}"#
            )
            .unwrap(),
            vec![
                SseDelta::ItemPhase {
                    item_id: "m".into(),
                    phase: "final_answer".into()
                },
                SseDelta::TextForItemDone {
                    item_id: "m".into(),
                    content_index: Some(0),
                    text: "answer".into()
                },
                SseDelta::Done,
            ]
        );
    }

    #[test]
    fn failed_event_emits_embedded_partial_before_typed_error() {
        let deltas = parse_openai_event(
            r#"{"type":"response.failed","response":{"error":{"message":"failed"},"output":[{"id":"m","content":[{"type":"output_text","text":"partial","annotations":[{"title":"Source","url":"https://example.com"}]}]}]}}"#,
        )
        .expect("failed event");
        assert!(
            matches!(deltas.first(), Some(SseDelta::TextForItemDone { text, content_index: Some(0), .. }) if text == "partial")
        );
        assert!(
            matches!(deltas.get(1), Some(SseDelta::Citation { url, .. }) if url == "https://example.com")
        );
        assert!(matches!(deltas.get(2), Some(SseDelta::Error(message)) if message == "failed"));
    }

    #[test]
    fn handles_crlf_and_lf_boundaries_and_multiple_data_lines() {
        let mut decoder = SseDecoder::default();
        let events = decoder
            .push(
                b"event: message\r\ndata: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"ok\"}\r\n\r\ndata: [DONE]\n\n",
            )
            .unwrap();
        assert_eq!(
            events,
            vec![
                "{\"type\":\"response.output_text.delta\",\n\"delta\":\"ok\"}".to_string(),
                "[DONE]".to_string(),
            ]
        );
        assert_eq!(
            parse_openai_event(&events[0]).unwrap(),
            vec![SseDelta::TextDelta {
                item_id: None,
                content_index: None,
                text: "ok".into()
            }]
        );
    }

    #[test]
    fn flushes_a_final_event_without_trailing_blank_line() {
        let mut decoder = SseDecoder::default();
        decoder.push(b"data: [DONE]").unwrap();
        assert_eq!(decoder.finish().unwrap(), vec!["[DONE]"]);
    }

    #[test]
    fn rejects_oversized_complete_and_unterminated_events() {
        let mut complete = SseDecoder {
            pending: Vec::new(),
            max_event_bytes: 8,
        };
        assert_eq!(
            complete.push(b"data: 123456789\n\n"),
            Err("Provider stream event exceeds the 8-byte limit".into())
        );

        let mut pending = SseDecoder {
            pending: Vec::new(),
            max_event_bytes: 8,
        };
        assert_eq!(
            pending.push(b"data: 123"),
            Err("Provider stream event exceeds the 8-byte limit".into())
        );
    }
}
