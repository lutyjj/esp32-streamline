//! ESP-IDF HTTP binding for the official OTLP exporter feasibility experiment.

use std::{sync::mpsc::sync_channel, time::Duration};

use anyhow::Result;
use embedded_svc::http::client::Client;
use esp_idf_svc::{
    hal::task::thread::ThreadSpawnConfiguration,
    http::client::{Configuration, EspHttpConnection},
    io::Write,
};
use opentelemetry_http::{Bytes, HttpClient, HttpError, Request, Response};

#[derive(Debug)]
struct EspHttp;

#[async_trait::async_trait]
impl HttpClient for EspHttp {
    async fn send_bytes(&self, request: Request<Bytes>) -> Result<Response<Bytes>, HttpError> {
        let mut client = Client::wrap(EspHttpConnection::new(&Configuration {
            timeout: Some(Duration::from_millis(500)),
            buffer_size: Some(512),
            buffer_size_tx: Some(512),
            ..Default::default()
        })?);
        let url = request.uri().to_string();
        let length = request.body().len().to_string();
        let headers = [
            ("Content-Type", "application/x-protobuf"),
            ("Content-Length", length.as_str()),
        ];
        let mut outgoing = client.post(&url, &headers)?;
        outgoing.write_all(request.body())?;
        let mut incoming = outgoing.submit()?;
        let status = incoming.status();
        let mut body = [0; 512];
        let mut read = 0;
        loop {
            let count = incoming.read(&mut body[read..])?;
            if count == 0 {
                break;
            }
            read += count;
            if read == body.len() {
                return Err(std::io::Error::other("OTLP response exceeds 511 bytes").into());
            }
        }
        // ESP-IDF reports bytes, unlike upstream FreeRTOS's word count.
        let unused = unsafe { esp_idf_svc::sys::uxTaskGetStackHighWaterMark(std::ptr::null_mut()) };
        log::info!("telemetry task minimum unused stack: {unused} bytes");
        Ok(Response::builder()
            .status(status)
            .body(Bytes::copy_from_slice(&body[..read]))?)
    }
}

pub fn start() -> Result<()> {
    let Some(endpoint) = option_env!("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") else {
        return Ok(());
    };
    let (sender, receiver) = sync_channel(4);
    let task = super::task::prepare(
        ThreadSpawnConfiguration {
            name: Some(c"otel"),
            stack_size: 12_288,
            priority: 3,
            ..Default::default()
        },
        move || {
            if let Err(error) = crate::tracing_poc::export(receiver, endpoint, EspHttp) {
                log::warn!("telemetry worker stopped: {error}");
            }
        },
    )?;
    crate::tracing_poc::install(sender);
    task.commit();
    Ok(())
}
