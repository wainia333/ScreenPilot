use crate::infrastructure::provider_http::{
    client, read_response_bytes_limited, send_request, MAX_ERROR_BODY_BYTES,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::header::{CONTENT_TYPE, REFERER, USER_AGENT};

const BAIDU_TTS_ENDPOINT: &str = "https://fanyi.baidu.com/gettts";
const BAIDU_TTS_REFERER: &str = "https://fanyi.baidu.com/";
const BAIDU_TTS_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const MAX_SPEECH_AUDIO_BYTES: usize = 16 * 1024 * 1024;

pub async fn synthesize_data_url(text: &str) -> Result<String, String> {
    synthesize_data_url_at(BAIDU_TTS_ENDPOINT, text).await
}

async fn synthesize_data_url_at(endpoint: &str, text: &str) -> Result<String, String> {
    let cleaned = text.replace("***", "");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err("Speech text is empty".into());
    }

    let response = send_request(
        client()?
            .get(endpoint)
            .query(&[
                ("lan", speech_language(trimmed)),
                ("text", trimmed),
                ("spd", "5"),
                ("source", "web"),
            ])
            .header(USER_AGENT, BAIDU_TTS_USER_AGENT)
            .header(REFERER, BAIDU_TTS_REFERER),
        None,
    )
    .await?;

    let status = response.status();
    if !status.is_success() {
        let _ = read_response_bytes_limited(
            response,
            MAX_ERROR_BODY_BYTES,
            "Baidu speech error response",
            None,
        )
        .await;
        return Err(format!(
            "Baidu speech response returned HTTP {}",
            status.as_u16()
        ));
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("audio/") {
        return Err("Baidu speech response was not audio".into());
    }

    let bytes = read_response_bytes_limited(
        response,
        MAX_SPEECH_AUDIO_BYTES,
        "Baidu speech response",
        None,
    )
    .await?;
    if bytes.is_empty() {
        return Err("Baidu speech response was empty".into());
    }

    Ok(format!("data:audio/mpeg;base64,{}", STANDARD.encode(bytes)))
}

fn speech_language(text: &str) -> &'static str {
    if text.chars().any(|character| {
        matches!(
            character,
            '\u{3400}'..='\u{9FFF}'
                | '\u{F900}'..='\u{FAFF}'
                | '\u{3040}'..='\u{30FF}'
                | '\u{AC00}'..='\u{D7AF}'
        )
    }) {
        "zh"
    } else {
        "en"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn chooses_the_reference_provider_language_contract() {
        assert_eq!(speech_language("Hello, ScreenPilot"), "en");
        assert_eq!(speech_language("你好，ScreenPilot"), "zh");
        assert_eq!(speech_language("こんにちは"), "zh");
        assert_eq!(speech_language("한국어"), "zh");
    }

    #[tokio::test]
    async fn requests_baidu_web_speech_and_returns_mpeg_data_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gettts"))
            .and(query_param("lan", "zh"))
            .and(query_param("text", "你好 ScreenPilot"))
            .and(query_param("spd", "5"))
            .and(query_param("source", "web"))
            .and(header("referer", BAIDU_TTS_REFERER))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "audio/mpeg")
                    .set_body_bytes(b"synthetic-mpeg"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let result = synthesize_data_url_at(
            &format!("{}/gettts", server.uri()),
            "***你好 ScreenPilot***",
        )
        .await;
        assert_eq!(
            result.expect("speech response"),
            format!(
                "data:audio/mpeg;base64,{}",
                STANDARD.encode(b"synthetic-mpeg")
            )
        );
        let requests = server
            .received_requests()
            .await
            .expect("recorded speech request");
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0]
                .headers
                .get("user-agent")
                .and_then(|value| value.to_str().ok()),
            Some(BAIDU_TTS_USER_AGENT)
        );
    }

    #[tokio::test]
    async fn rejects_non_audio_and_empty_input() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gettts"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/html")
                    .set_body_string("not audio"),
            )
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            synthesize_data_url_at(&format!("{}/gettts", server.uri()), "hello").await,
            Err("Baidu speech response was not audio".into())
        );
        assert_eq!(
            synthesize_data_url_at(&format!("{}/gettts", server.uri()), " *** ").await,
            Err("Speech text is empty".into())
        );
    }
}
