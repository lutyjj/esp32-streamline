//! Admin-key authorization for mutating HTTP requests.

use crate::{api::Endpoint, auth::authorized_secret};

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
