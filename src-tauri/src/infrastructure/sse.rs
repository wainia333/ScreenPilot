use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SseDelta {
    Text(String),
    Reasoning(String),
    Done,
    Error(String),
}

#[derive(Default)]
pub struct SseDecoder {
    pending: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((end, delimiter)) = event_boundary(&self.pending) {
            let event = self.pending.drain(..end).collect::<Vec<_>>();
            self.pending.drain(..delimiter);
            if let Some(data) = decode_event(&event)? {
                events.push(data);
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, String> {
        if self.pending.iter().all(u8::is_ascii_whitespace) {
            self.pending.clear();
            return Ok(Vec::new());
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
    if let Some(message) = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            (value.get("type").and_then(Value::as_str) == Some("error"))
                .then(|| value.get("message").and_then(Value::as_str))
                .flatten()
        })
    {
        return Ok(vec![SseDelta::Error(message.to_string())]);
    }
    let event_type = value.get("type").and_then(Value::as_str);
    if matches!(event_type, Some("response.completed" | "response.done")) {
        return Ok(vec![SseDelta::Done]);
    }
    if matches!(
        event_type,
        Some("response.output_text.delta" | "response.content_part.delta")
    ) {
        return Ok(value
            .get("delta")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| vec![SseDelta::Text(text.to_string())])
            .unwrap_or_default());
    }
    if matches!(
        event_type,
        Some("response.reasoning_summary_text.delta" | "response.reasoning_text.delta")
    ) {
        return Ok(value
            .get("delta")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| vec![SseDelta::Reasoning(text.to_string())])
            .unwrap_or_default());
    }
    let mut deltas = Vec::new();
    if let Some(text) = value
        .pointer("/choices/0/delta/reasoning_content")
        .or_else(|| value.pointer("/choices/0/delta/reasoning"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        deltas.push(SseDelta::Reasoning(text.to_string()));
    }
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        deltas.push(SseDelta::Text(text.to_string()));
    }
    if value
        .pointer("/choices/0/finish_reason")
        .is_some_and(|reason| !reason.is_null())
    {
        deltas.push(SseDelta::Done);
    }
    Ok(deltas)
}

fn event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (position, 4))
        .or_else(|| {
            bytes
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|position| (position, 2))
        })
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
            vec![SseDelta::Text("你好".into())]
        );
    }

    #[test]
    fn parses_chat_responses_done_and_errors() {
        assert_eq!(parse_openai_event("[DONE]").unwrap(), vec![SseDelta::Done]);
        assert_eq!(
            parse_openai_event(r#"{"type":"response.output_text.delta","delta":"answer"}"#)
                .unwrap(),
            vec![SseDelta::Text("answer".into())]
        );
        assert_eq!(
            parse_openai_event(
                r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#
            )
            .unwrap(),
            vec![SseDelta::Reasoning("thinking".into())]
        );
        assert_eq!(
            parse_openai_event(r#"{"error":{"message":"denied"}}"#).unwrap(),
            vec![SseDelta::Error("denied".into())]
        );
    }

    #[test]
    fn flushes_a_final_event_without_trailing_blank_line() {
        let mut decoder = SseDecoder::default();
        decoder.push(b"data: [DONE]").unwrap();
        assert_eq!(decoder.finish().unwrap(), vec!["[DONE]"]);
    }
}
