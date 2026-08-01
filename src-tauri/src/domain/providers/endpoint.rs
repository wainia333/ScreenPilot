use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApiProtocol {
    ChatCompletions,
    Responses,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEndpoints {
    pub request: Url,
    pub models: Url,
    pub protocol: ApiProtocol,
}

pub fn derive_endpoints(input: &str) -> Result<ProviderEndpoints, String> {
    let mut request = Url::parse(input).map_err(|_| "Provider URL is invalid")?;
    request.set_query(None);
    request.set_fragment(None);
    let path = request.path().trim_end_matches('/');
    let (request_path, models_path, protocol) =
        if let Some(root) = path.strip_suffix("/chat/completions") {
            (
                path.to_string(),
                format!("{root}/models"),
                ApiProtocol::ChatCompletions,
            )
        } else if let Some(root) = path.strip_suffix("/responses") {
            (
                path.to_string(),
                format!("{root}/models"),
                ApiProtocol::Responses,
            )
        } else if let Some(root) = path.strip_suffix("/models") {
            (
                format!("{root}/chat/completions"),
                path.to_string(),
                ApiProtocol::ChatCompletions,
            )
        } else {
            let root = if path.is_empty() { "" } else { path };
            (
                format!("{root}/chat/completions"),
                format!("{root}/models"),
                ApiProtocol::ChatCompletions,
            )
        };
    request.set_path(&request_path);
    let mut models = request.clone();
    models.set_path(&models_path);
    Ok(ProviderEndpoints {
        request,
        models,
        protocol,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_models_from_supported_endpoint_shapes() {
        let cases = [
            (
                "https://api.example.com/v1",
                "https://api.example.com/v1/chat/completions",
                "https://api.example.com/v1/models",
                ApiProtocol::ChatCompletions,
            ),
            (
                "https://api.example.com/v1/chat/completions?ignored=true",
                "https://api.example.com/v1/chat/completions",
                "https://api.example.com/v1/models",
                ApiProtocol::ChatCompletions,
            ),
            (
                "https://api.example.com/openai/responses",
                "https://api.example.com/openai/responses",
                "https://api.example.com/openai/models",
                ApiProtocol::Responses,
            ),
            (
                "http://127.0.0.1:11434/v1/models",
                "http://127.0.0.1:11434/v1/chat/completions",
                "http://127.0.0.1:11434/v1/models",
                ApiProtocol::ChatCompletions,
            ),
        ];
        for (input, request, models, protocol) in cases {
            let endpoints = derive_endpoints(input).expect("derive endpoints");
            assert_eq!(endpoints.request.as_str(), request);
            assert_eq!(endpoints.models.as_str(), models);
            assert_eq!(endpoints.protocol, protocol);
        }
    }
}
