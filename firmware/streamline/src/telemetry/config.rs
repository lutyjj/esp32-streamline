//! Validated, volatile diagnostic-session configuration.

use opentelemetry_http::Request;
use serde::{Deserialize, Serialize};

use crate::mutation::MutationError;

pub use super::semconv::SAMPLE_INTERVAL;
pub const MAX_SESSION_SECONDS: u32 = 3600;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    /// Complete OTLP HTTP/protobuf traces URL, including /v1/traces.
    #[cfg_attr(feature = "api-spec", schema(max_length = 512))]
    pub endpoint: String,
    /// The session expires automatically and never survives a reboot.
    #[cfg_attr(feature = "api-spec", schema(minimum = 30, maximum = 3600))]
    pub duration_seconds: u32,
    /// Explicit consent to send metadata over an unencrypted trusted LAN.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(default = false))]
    pub allow_insecure: bool,
    /// Optional credential; accepted only with HTTPS and never returned.
    #[serde(default)]
    #[cfg_attr(
        feature = "api-spec",
        schema(write_only, max_length = 512, default = "")
    )]
    pub bearer_token: String,
    /// Optional PEM trust anchor for a private HTTPS collector.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(max_length = 2048, default = ""))]
    pub ca_certificate_pem: String,
}

impl SessionRequest {
    pub fn validate(&self) -> Result<(), MutationError> {
        let invalid = |message: &str| MutationError::InvalidInput(message.to_owned());
        if !(30..=MAX_SESSION_SECONDS).contains(&self.duration_seconds) {
            return Err(invalid("duration_seconds must be between 30 and 3600"));
        }
        if self.endpoint.len() > 512 || self.endpoint.contains(['@', '#', '\0']) {
            return Err(invalid(
                "endpoint must be a URL without credentials or fragments, at most 512 bytes",
            ));
        }
        let request = Request::builder()
            .uri(&self.endpoint)
            .body(())
            .map_err(|_| invalid("endpoint is not a valid HTTP URL"))?;
        let uri = request.uri();
        if uri.host().is_none() || uri.query().is_some() || !uri.path().ends_with("/v1/traces") {
            return Err(invalid(
                "endpoint must include a host and end in /v1/traces without a query",
            ));
        }
        match uri.scheme_str() {
            Some("https") => {}
            Some("http")
                if self.allow_insecure
                    && self.bearer_token.is_empty()
                    && self.ca_certificate_pem.is_empty() => {}
            _ => {
                return Err(invalid(
                    "HTTPS is required; credential-free HTTP requires allow_insecure",
                ))
            }
        }
        if self.bearer_token.len() > 512 || self.bearer_token.bytes().any(|b| !b.is_ascii_graphic())
        {
            return Err(invalid(
                "bearer_token must contain at most 512 visible ASCII bytes",
            ));
        }
        if self.ca_certificate_pem.len() > 2048 || self.ca_certificate_pem.contains('\0') {
            return Err(invalid(
                "ca_certificate_pem must contain at most 2048 bytes without NUL",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(endpoint: &str) -> SessionRequest {
        SessionRequest {
            endpoint: endpoint.into(),
            duration_seconds: 60,
            allow_insecure: false,
            bearer_token: String::new(),
            ca_certificate_pem: String::new(),
        }
    }

    #[test]
    fn insecure_export_needs_consent_and_cannot_carry_credentials() {
        let mut config = request("http://192.0.2.1:4318/v1/traces");
        assert!(config.validate().is_err());
        config.allow_insecure = true;
        assert!(config.validate().is_ok());
        config.bearer_token = "example".into();
        assert!(config.validate().is_err());
        config.endpoint = "https://collector.example/v1/traces".into();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn endpoint_validation_rejects_hidden_credentials_and_wrong_protocols() {
        for endpoint in [
            "https://user:secret@collector.example/v1/traces",
            "https://collector.example/v1/traces?token=secret",
            "https://collector.example/v1/traces#fragment",
            "file:///v1/traces",
            "/v1/traces",
            "https://collector.example/other",
        ] {
            assert!(request(endpoint).validate().is_err(), "{endpoint}");
        }
    }
}
