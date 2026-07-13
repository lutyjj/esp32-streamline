//! HTTP response encoding and reboot handoff.

use anyhow::Result;
use embedded_svc::io::Write;
use serde::Serialize;

use crate::api;

pub(super) fn reboot_response<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    json_response(request, 200, &api::Ack::rebooting())?;
    // Restart from a detached task so this handler returns and the server
    // completes the chunked response. Restarting inside the handler leaves
    // the terminating chunk unsent, and every client that reads the body to
    // its end then hangs until the reboot kills the connection.
    std::thread::spawn(|| {
        esp_idf_svc::hal::delay::FreeRtos::delay_ms(500);
        unsafe { esp_idf_svc::sys::esp_restart() };
    });
    Ok(())
}

pub(super) fn respond<C>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    content_type: &str,
    body: &str,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    request
        .into_response(
            code,
            None,
            &[
                ("Content-Type", content_type),
                ("Cache-Control", "no-store"),
            ],
        )?
        .write_all(body.as_bytes())?;
    Ok(())
}

/// Answer an OTA trigger: `202` once the background worker is running, or `409`
/// with the reason if one is already in progress.
pub(super) fn ota_accepted<C>(
    request: embedded_svc::http::server::Request<C>,
    spawned: anyhow::Result<()>,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    match spawned {
        Ok(()) => json_response(request, 202, &api::Ack::started()),
        Err(error) => error_response(request, 409, &error.to_string()),
    }
}

pub(super) fn unauthorized<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, 401, "unauthorized")
}

pub(super) fn bad_request<C>(
    request: embedded_svc::http::server::Request<C>,
    error: anyhow::Error,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, 400, &error.to_string())
}

pub(super) fn unavailable<C>(
    request: embedded_svc::http::server::Request<C>,
    message: &str,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, 503, message)
}

pub(super) fn json_response<C, T>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    value: &T,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: Serialize,
{
    respond(request, code, "application/json", &serialize(value))
}

fn error_response<C>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    message: &str,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    json_response(request, code, &api::ErrorResponse { error: message })
}

/// Serialize an owned response built entirely from primitives and `&str`, which
/// `serde_json` never fails to encode.
pub(super) fn serialize<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("response is always serializable")
}
