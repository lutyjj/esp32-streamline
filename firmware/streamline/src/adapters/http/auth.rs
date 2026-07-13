//! Admin-key authorization for mutating HTTP requests.

use crate::api::Endpoint;

use super::ApiState;

/// Authorize a mutating request against the configured admin key.
///
/// An unprovisioned device (empty key) accepts writes so it can be commissioned
/// over its own setup AP. Once a key is set, callers must present it as a
/// `Bearer` token. Using a custom header (rather than a cookie or HTTP Basic) makes
/// the API CSRF-safe: a cross-origin browser request carrying it triggers a CORS
/// preflight that this server never approves.
fn authorized<C>(request: &embedded_svc::http::server::Request<C>, state: &ApiState) -> bool
where
    C: embedded_svc::http::server::Connection,
{
    let secret = match state.config.lock() {
        Ok(config) => config.admin_secret.clone(),
        Err(_) => return false,
    };
    if secret.is_empty() {
        return true;
    }
    authorized_secret(&secret, request.header("Authorization"))
}

pub(super) fn authorized_for<C>(
    request: &embedded_svc::http::server::Request<C>,
    state: &ApiState,
    endpoint: Endpoint,
) -> bool
where
    C: embedded_svc::http::server::Connection,
{
    !endpoint.auth || authorized(request, state)
}

fn authorized_secret(secret: &str, authorization: Option<&str>) -> bool {
    if secret.is_empty() {
        return true;
    }
    match authorization.and_then(|value| value.strip_prefix("Bearer ")) {
        Some(token) => constant_time_eq(token.as_bytes(), secret.as_bytes()),
        None => false,
    }
}

/// Length-checked constant-time byte comparison so key validation does not leak
/// through response timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::{authorized_secret, constant_time_eq};

    #[test]
    fn constant_time_eq_matches_only_identical_secrets() {
        assert!(constant_time_eq(b"console-secret", b"console-secret"));
        assert!(!constant_time_eq(b"console-secret", b"console-secre"));
        assert!(!constant_time_eq(b"console-secret", b"console-secreX"));
        assert!(!constant_time_eq(b"", b"x"));
    }

    #[test]
    fn bearer_secret_authorizes_mutating_requests() {
        assert!(authorized_secret("", None));
        assert!(authorized_secret(
            "console-secret",
            Some("Bearer console-secret")
        ));
        assert!(!authorized_secret("console-secret", None));
        assert!(!authorized_secret("console-secret", Some("console-secret")));
        assert!(!authorized_secret(
            "console-secret",
            Some("Bearer console-secreX")
        ));
    }
}
