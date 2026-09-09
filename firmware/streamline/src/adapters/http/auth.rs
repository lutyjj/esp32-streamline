//! Digest authorization for mutating HTTP requests.

use crate::{
    adapters::random::EspRandom,
    api::{Endpoint, HttpMethod},
    auth::Verdict,
};

use super::ApiState;

/// Authorize a request against the configured admin key, RFC 7616 digest.
///
/// An unprovisioned device (empty key) accepts writes so it can be
/// commissioned over its own setup AP. Once a key is set, callers must
/// answer the device's digest challenge; `Err` carries the
/// `WWW-Authenticate` value the 401 response must send. The `Authorization`
/// header is set by script, not by ambient browser credentials, so the API
/// stays CSRF-safe: a cross-origin request triggers a CORS preflight this
/// server never approves.
pub(super) fn authorized_for<C>(
    request: &embedded_svc::http::server::Request<C>,
    state: &ApiState,
    endpoint: Endpoint,
) -> Result<(), String>
where
    C: embedded_svc::http::server::Connection,
{
    if !endpoint.auth {
        return Ok(());
    }
    let secret = match state.config.lock() {
        Ok(config) => config.admin_key.clone(),
        Err(_) => return Err(challenge(state, false)),
    };
    let method = match endpoint.method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
    };
    let verdict = match state.auth.lock() {
        Ok(mut auth) => auth.authorize(
            &secret,
            method,
            request.uri(),
            request.header("Authorization"),
            now_ms(),
        ),
        Err(_) => Verdict::Denied { stale: false },
    };
    match verdict {
        Verdict::Authorized => Ok(()),
        Verdict::Denied { stale } => Err(challenge(state, stale)),
    }
}

fn challenge(state: &ApiState, stale: bool) -> String {
    match state.auth.lock() {
        Ok(mut auth) => auth.challenge(&mut EspRandom, now_ms(), stale),
        // A poisoned authenticator cannot mint a verifiable nonce; keep the
        // 401 well-formed so clients still see a digest surface.
        Err(_) => format!("Digest realm=\"{}\"", crate::auth::REALM),
    }
}

/// Monotonic milliseconds since boot, the clock nonce lifetimes run on.
fn now_ms() -> u64 {
    (unsafe { esp_idf_svc::sys::esp_timer_get_time() } / 1_000) as u64
}
