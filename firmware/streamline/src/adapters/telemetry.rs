//! Fallible ESP32 task admission and native HTTP(S) for the OTLP SDK exporter.

use crate::{
    mutation::MutationError,
    telemetry::{Session, SessionRequest, Telemetry},
};
use embedded_svc::http::client::Client;
use esp_idf_svc::{
    hal::task::thread::ThreadSpawnConfiguration,
    http::client::{Configuration, EspHttpConnection, FollowRedirectsPolicy},
    io::Write,
    sys,
    tls::X509,
};
use opentelemetry_http::{Bytes, HttpClient, HttpError, Request, Response};
use opentelemetry_otlp::{RetryPolicy, WithExportConfig, WithHttpConfig};
use std::{
    ffi::{CStr, CString},
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};

const WORKER_STACK: usize = 12_288;
const MIN_FREE_HEAP: usize = 49_152;
const MIN_HTTPS_HEAP: usize = 98_304;
const MIN_LARGEST_BLOCK: usize = 16_384;

fn heap_available(required: usize) -> bool {
    let capabilities = sys::MALLOC_CAP_INTERNAL | sys::MALLOC_CAP_8BIT;
    let free = unsafe { sys::heap_caps_get_free_size(capabilities) };
    let largest = unsafe { sys::heap_caps_get_largest_free_block(capabilities) };
    free >= required && largest >= MIN_LARGEST_BLOCK
}

struct EspHttp {
    ca: Option<CString>,
}
impl fmt::Debug for EspHttp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EspHttp")
    }
}

#[async_trait::async_trait]
impl HttpClient for EspHttp {
    async fn send_bytes(&self, request: Request<Bytes>) -> Result<Response<Bytes>, HttpError> {
        // Recheck after SDK encoding: Wi-Fi and management requests share the
        // heap, and admission alone cannot reserve their future allocations.
        let required = if request.uri().scheme_str() == Some("https") {
            81_920
        } else {
            24_576
        };
        if !heap_available(required) {
            return Err(std::io::Error::other("insufficient heap for telemetry export").into());
        }
        let started = Instant::now();
        // esp-idf-svc requires a static certificate even for a scoped client.
        // SAFETY: self owns this PEM throughout send_bytes; the native client
        // is local, is dropped before return, and cannot escape in the response.
        let certificate = self
            .ca
            .as_ref()
            .map(|pem| unsafe { X509::pem(&*(pem.as_c_str() as *const CStr)) });
        let mut client = Client::wrap(EspHttpConnection::new(&Configuration {
            timeout: Some(Duration::from_millis(500)),
            buffer_size: Some(512),
            buffer_size_tx: Some(512),
            follow_redirects_policy: FollowRedirectsPolicy::FollowNone,
            server_certificate: certificate,
            crt_bundle_attach: if certificate.is_none() {
                Some(sys::esp_crt_bundle_attach)
            } else {
                None
            },
            ..Default::default()
        })?);
        let url = request.uri().to_string();
        let length = request.body().len().to_string();
        let mut headers = Vec::with_capacity(request.headers().len() + 1);
        for (key, value) in request.headers() {
            if key.as_str() != "content-length" {
                headers.push((key.as_str(), value.to_str()?));
            }
        }
        headers.push(("Content-Length", &length));
        let mut outgoing = client.post(&url, &headers)?;
        outgoing.write_all(request.body())?;
        let mut incoming = outgoing.submit()?;
        let status = incoming.status();
        let mut body = [0; 512];
        let mut read = 0;
        loop {
            if started.elapsed() > Duration::from_secs(2) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "OTLP response deadline exceeded",
                )
                .into());
            }
            let count = incoming.read(&mut body[read..])?;
            if count == 0 {
                break;
            }
            read += count;
            if read == body.len() {
                return Err(std::io::Error::other("OTLP response exceeds 511 bytes").into());
            }
        }
        let unused = unsafe { sys::uxTaskGetStackHighWaterMark(std::ptr::null_mut()) };
        log::debug!("telemetry worker minimum unused stack: {unused} bytes");
        Ok(Response::builder()
            .status(status)
            .body(Bytes::copy_from_slice(&body[..read]))?)
    }
}

pub fn start(manager: &Arc<Telemetry>, config: SessionRequest) -> Result<(), MutationError> {
    let unavailable =
        || MutationError::Unavailable("insufficient resources to start telemetry safely".into());
    // Reserve a diagnostic worker only when the streaming and management tasks
    // still have internal memory headroom. PSRAM does not satisfy this gate.
    let required = if config
        .endpoint
        .get(..6)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https:"))
    {
        MIN_HTTPS_HEAP
    } else {
        MIN_FREE_HEAP
    };
    if !heap_available(required) {
        return Err(unavailable());
    }
    let ca = if config.ca_certificate_pem.is_empty() {
        None
    } else {
        Some(
            CString::new(config.ca_certificate_pem.as_str())
                .map_err(|_| MutationError::InvalidInput("invalid PEM certificate".into()))?,
        )
    };
    let headers = if config.bearer_token.is_empty() {
        std::collections::HashMap::new()
    } else {
        std::collections::HashMap::from([(
            "Authorization".to_owned(),
            format!("Bearer {}", config.bearer_token),
        )])
    };
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(EspHttp { ca })
        .with_endpoint(&config.endpoint)
        .with_headers(headers)
        .with_timeout(Duration::from_millis(500))
        .with_retry_policy(RetryPolicy::disabled())
        .with_max_request_body_size(4096)
        .build()
        .map_err(|_| MutationError::InvalidInput("cannot configure OTLP exporter".into()))?;
    let (session, job) = Session::prepare(&config, manager.resource(), exporter);
    let worker_session = Arc::clone(&session);
    let worker_manager = Arc::clone(manager);
    let pending = super::task::prepare(
        ThreadSpawnConfiguration {
            name: Some(c"telemetry"),
            stack_size: WORKER_STACK,
            priority: 3,
            ..Default::default()
        },
        move || {
            job.run();
            worker_manager.stop();
            worker_session.release_sdk();
        },
    )
    .map_err(|_| unavailable())?;
    manager.install(session);
    pending.commit();
    Ok(())
}
