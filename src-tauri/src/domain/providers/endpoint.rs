use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiProtocol {
    ChatCompletions,
    #[default]
    Responses,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEndpoints {
    pub request: Url,
    pub models: Url,
    pub protocol: ApiProtocol,
}

/// Backward-compatible Responses-default endpoint derivation for callers that
/// do not persist an explicit protocol yet.
#[allow(dead_code)]
pub fn derive_endpoints(input: &str) -> Result<ProviderEndpoints, String> {
    derive_endpoints_with_protocol(input, ApiProtocol::default())
}

pub fn derive_endpoints_with_protocol(
    input: &str,
    preferred_protocol: ApiProtocol,
) -> Result<ProviderEndpoints, String> {
    let mut request = Url::parse(input).map_err(|_| "Provider URL is invalid")?;
    request.set_query(None);
    request.set_fragment(None);

    // `Url::path` is already percent-encoded and always uses `/` as the path
    // separator.  Keep the path's case and any proxy prefix intact; endpoint
    // names are case-sensitive and providers commonly mount their API below a
    // path such as `/openai/v1`.
    let path = request.path().trim_end_matches('/');
    let base_path = if path.is_empty() { "/v1" } else { path };
    let (request_path, models_path, protocol) =
        if let Some(root) = path.strip_suffix("/chat/completions") {
            // A complete endpoint is an explicit user choice regardless of its
            // proxy prefix. Do not reinterpret it as a Responses endpoint.
            (
                path.to_string(),
                append_path(root, "models"),
                ApiProtocol::ChatCompletions,
            )
        } else if let Some(root) = path.strip_suffix("/responses") {
            (
                path.to_string(),
                append_path(root, "models"),
                ApiProtocol::Responses,
            )
        } else if let Some(root) = path.strip_suffix("/models") {
            (
                append_path(root, protocol_path(preferred_protocol)),
                path.to_string(),
                preferred_protocol,
            )
        } else {
            (
                append_path(base_path, protocol_path(preferred_protocol)),
                append_path(base_path, "models"),
                preferred_protocol,
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

fn protocol_path(protocol: ApiProtocol) -> &'static str {
    match protocol {
        ApiProtocol::ChatCompletions => "chat/completions",
        ApiProtocol::Responses => "responses",
    }
}

fn append_path(prefix: &str, suffix: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    format!("{prefix}/{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_models_from_supported_endpoint_shapes() {
        let cases = [
            (
                "https://api.example.com/v1",
                "https://api.example.com/v1/responses",
                "https://api.example.com/v1/models",
                ApiProtocol::Responses,
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
                "http://127.0.0.1:11434/v1/responses",
                "http://127.0.0.1:11434/v1/models",
                ApiProtocol::Responses,
            ),
        ];
        for (input, request, models, protocol) in cases {
            let endpoints = derive_endpoints(input).expect("derive endpoints");
            assert_eq!(endpoints.request.as_str(), request);
            assert_eq!(endpoints.models.as_str(), models);
            assert_eq!(endpoints.protocol, protocol);
        }
    }

    #[test]
    fn derives_default_endpoints_for_domain_and_version_roots() {
        let cases = [
            (
                "https://api.example.com",
                "https://api.example.com/v1/responses",
                "https://api.example.com/v1/models",
            ),
            (
                "https://api.example.com/",
                "https://api.example.com/v1/responses",
                "https://api.example.com/v1/models",
            ),
            (
                "https://api.example.com/v1/",
                "https://api.example.com/v1/responses",
                "https://api.example.com/v1/models",
            ),
            (
                "https://proxy.example.com/openai/v1/",
                "https://proxy.example.com/openai/v1/responses",
                "https://proxy.example.com/openai/v1/models",
            ),
        ];
        for (input, request, models) in cases {
            let endpoints = derive_endpoints(input).expect("derive endpoints");
            assert_eq!(endpoints.request.as_str(), request);
            assert_eq!(endpoints.models.as_str(), models);
            assert_eq!(endpoints.protocol, ApiProtocol::Responses);
        }
    }

    #[test]
    fn preserves_proxy_prefixes_for_explicit_endpoints() {
        let cases = [
            (
                "https://proxy.example.com/gateway/v1/responses/",
                "https://proxy.example.com/gateway/v1/responses",
                "https://proxy.example.com/gateway/v1/models",
                ApiProtocol::Responses,
            ),
            (
                "https://proxy.example.com/gateway/v1/chat/completions/",
                "https://proxy.example.com/gateway/v1/chat/completions",
                "https://proxy.example.com/gateway/v1/models",
                ApiProtocol::ChatCompletions,
            ),
            (
                "https://proxy.example.com/gateway/chat/completions/",
                "https://proxy.example.com/gateway/chat/completions",
                "https://proxy.example.com/gateway/models",
                ApiProtocol::ChatCompletions,
            ),
            (
                "https://proxy.example.com/gateway/v1/models/",
                "https://proxy.example.com/gateway/v1/responses",
                "https://proxy.example.com/gateway/v1/models",
                ApiProtocol::Responses,
            ),
        ];
        for (input, request, models, protocol) in cases {
            let endpoints = derive_endpoints(input).expect("derive endpoints");
            assert_eq!(endpoints.request.as_str(), request);
            assert_eq!(endpoints.models.as_str(), models);
            assert_eq!(endpoints.protocol, protocol);
        }
    }

    #[test]
    fn uses_explicit_protocol_for_roots_and_models_endpoints() {
        for input in [
            "https://proxy.example.com/gateway",
            "https://proxy.example.com/gateway/",
            "https://proxy.example.com/gateway/models",
            "https://proxy.example.com/gateway/models/",
        ] {
            let endpoints = derive_endpoints_with_protocol(input, ApiProtocol::ChatCompletions)
                .expect("derive chat endpoints");
            assert_eq!(
                endpoints.request.as_str(),
                "https://proxy.example.com/gateway/chat/completions"
            );
            assert_eq!(
                endpoints.models.as_str(),
                "https://proxy.example.com/gateway/models"
            );
            assert_eq!(endpoints.protocol, ApiProtocol::ChatCompletions);
        }
    }

    #[test]
    fn strips_query_and_fragment_before_deriving_paths() {
        let endpoints = derive_endpoints("https://api.example.com/v1?key=secret#fragment")
            .expect("derive endpoints");
        assert_eq!(
            endpoints.request.as_str(),
            "https://api.example.com/v1/responses"
        );
        assert_eq!(
            endpoints.models.as_str(),
            "https://api.example.com/v1/models"
        );

        let explicit =
            derive_endpoints("https://api.example.com/v1/chat/completions/?ignored=true#ignored")
                .expect("derive explicit endpoint");
        assert_eq!(
            explicit.request.as_str(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            explicit.models.as_str(),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn follows_url_case_and_unicode_semantics() {
        let uppercase_host = derive_endpoints("HTTPS://API.EXAMPLE.COM/v1/")
            .expect("uppercase scheme and host should parse");
        assert_eq!(
            uppercase_host.request.as_str(),
            "https://api.example.com/v1/responses"
        );

        let uppercase_path = derive_endpoints("https://api.example.com/V1/CHAT/COMPLETIONS")
            .expect("uppercase path should parse");
        assert_eq!(
            uppercase_path.request.as_str(),
            "https://api.example.com/V1/CHAT/COMPLETIONS/responses"
        );
        assert_eq!(
            uppercase_path.models.as_str(),
            "https://api.example.com/V1/CHAT/COMPLETIONS/models"
        );
        assert_eq!(uppercase_path.protocol, ApiProtocol::Responses);

        let unicode =
            derive_endpoints("https://例え.テスト/v1/").expect("unicode URL should parse");
        assert_eq!(unicode.request.host_str(), Some("xn--r8jz45g.xn--zckzah"));
        assert_eq!(unicode.request.path(), "/v1/responses");
        assert_eq!(unicode.models.path(), "/v1/models");

        let unicode_prefix = derive_endpoints("https://api.example.com/租户/v1/")
            .expect("unicode path should parse");
        assert_eq!(
            unicode_prefix.request.as_str(),
            "https://api.example.com/%E7%A7%9F%E6%88%B7/v1/responses"
        );
        assert_eq!(
            unicode_prefix.models.as_str(),
            "https://api.example.com/%E7%A7%9F%E6%88%B7/v1/models"
        );
    }

    #[test]
    fn rejects_invalid_urls() {
        for input in ["", "not a URL", "/v1", "https://", "https://[::1"] {
            assert_eq!(
                derive_endpoints(input),
                Err("Provider URL is invalid".into())
            );
        }
    }
}
