//! HTTP response encoding and reboot handoff.

use anyhow::Result;
use embedded_svc::io::Write;
use serde::Serialize;

use crate::{api, mutation::MutationError};

pub(super) fn reboot_response<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    reboot_response_with(request, &api::Ack::rebooting())
}

/// Acknowledge with `body`, then restart. The restart runs on a detached task
/// so this handler returns and the server completes the chunked response.
/// Restarting inside the handler leaves the terminating chunk unsent, and
/// every client that reads the body to its end then hangs until the reboot
/// kills the connection.
pub(super) fn reboot_response_with<C>(
    request: embedded_svc::http::server::Request<C>,
    body: &impl Serialize,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    json_response(request, 200, body)?;
    std::thread::spawn(|| {
        esp_idf_svc::hal::delay::FreeRtos::delay_ms(500);
        unsafe { esp_idf_svc::sys::esp_restart() };
    });
    Ok(())
}

/// Serve a body that build.rs stored gzipped (the embedded console and the
/// OpenAPI artifact), declared with `Content-Encoding: gzip`. Browsers and
/// HTTP client libraries decompress transparently; raw `curl` needs
/// `--compressed`. The encoding is unconditional because no identity copy
/// exists in flash — storing one would return the 144 KB the compression
/// reclaims.
pub(super) fn respond_gzip<C>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    content_type: &str,
    body: &[u8],
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
                ("Content-Encoding", "gzip"),
                ("Cache-Control", "no-store"),
            ],
        )?
        .write_all(body)?;
    Ok(())
}

pub(super) fn redirect_to_console<C>(
    request: embedded_svc::http::server::Request<C>,
    location: &str,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    request
        .into_response(
            303,
            Some("See Other"),
            &[
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Cache-Control", "no-store"),
                ("Location", location),
            ],
        )?
        .write_all(b"Open the StreamLine setup console.")?;
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

/// Answer a failed mutation with the status its category earns: invalid input
/// `400`, a state conflict `409`, an absent capability `503`, and a persistence
/// or internal fault `500`, instead of collapsing every failure into `400`.
pub(super) fn mutation_error<C>(
    request: embedded_svc::http::server::Request<C>,
    error: MutationError,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, error.status(), error.message())
}

pub(super) fn not_found<C>(
    request: embedded_svc::http::server::Request<C>,
    message: &str,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, 404, message)
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

/// Bytes buffered per response body. Bodies stream through this fixed window
/// instead of materializing in one heap block: several concurrent status
/// scrapes arriving while the packet queue is full must not multiply peak
/// heap into allocation failure.
const BODY_BUFFER_BYTES: usize = 1_024;

/// Adapt the connection's writer to `std::io::Write` so `serde_json` and
/// other std writers can stream a body straight into the response.
pub(super) struct StdWriter<W>(W);

impl<W: embedded_svc::io::Write> std::io::Write for StdWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .write(buffer)
            .map_err(|error| std::io::Error::other(format!("{error:?}")))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .flush()
            .map_err(|error| std::io::Error::other(format!("{error:?}")))
    }
}

/// Open a streaming response body with the standard headers.
pub(super) fn body_writer<C>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    content_type: &str,
) -> Result<std::io::BufWriter<StdWriter<embedded_svc::http::server::Response<C>>>>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    let response = request.into_response(
        code,
        None,
        &[
            ("Content-Type", content_type),
            ("Cache-Control", "no-store"),
        ],
    )?;
    Ok(std::io::BufWriter::with_capacity(
        BODY_BUFFER_BYTES,
        StdWriter(response),
    ))
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
    let mut writer = body_writer(request, code, "application/json")?;
    serde_json::to_writer(&mut writer, value)?;
    std::io::Write::flush(&mut writer)?;
    Ok(())
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
