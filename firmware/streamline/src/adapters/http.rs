//! Local provisioning and read-only runtime HTTP API.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, bail, Result};
use embedded_svc::{
    http::{Headers, Method},
    io::{Read, Write},
};
use esp_idf_svc::http::server::{Configuration, EspHttpServer};
use serde::Serialize;

use crate::{
    adapters::nvs::ConfigStore,
    config::{AudioSettings, InputLine, RuntimeConfig},
    levels::CLIP_THRESHOLD_ABS,
    runtime::StreamStatus,
};

const INDEX: &str = include_str!("../../web/index.html");
const MAX_REQUEST_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    SetupAp,
    Streaming,
}

pub struct ApiState {
    pub mode: Mode,
    pub config: Arc<Mutex<RuntimeConfig>>,
    pub store: Arc<Mutex<ConfigStore>>,
    pub stream: Option<Arc<StreamStatus>>,
}

pub fn start(state: Arc<ApiState>) -> Result<EspHttpServer<'static>> {
    let mut server = EspHttpServer::new(&Configuration {
        stack_size: 8_192,
        ..Default::default()
    })?;
    server.fn_handler("/", Method::Get, move |request| {
        respond(request, 200, "text/html; charset=utf-8", INDEX)
    })?;

    let state_for_status = Arc::clone(&state);
    server.fn_handler("/api/status", Method::Get, move |request| {
        respond(
            request,
            200,
            "application/json",
            &status_json(&state_for_status),
        )
    })?;

    let state_for_config = Arc::clone(&state);
    server.fn_handler("/api/config", Method::Get, move |request| {
        respond(
            request,
            200,
            "application/json",
            &config_json(&state_for_config),
        )
    })?;

    // The whole configuration API is writable in any mode on the trusted-LAN
    // assumption; request authentication is tracked separately (issue #6). A
    // Wi-Fi/target change reboots the device so it reconnects with the new
    // settings, which keeps swapping the stream target during testing cheap.
    let state_for_setup = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/setup", Method::Post, move |mut request| {
        let form = form(&mut request)?;
        let current = state_for_setup
            .config
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .clone();
        let password = form
            .get("password")
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or(current.password);
        let next = RuntimeConfig {
            ssid: required(&form, "ssid")?.to_owned(),
            password,
            target_host: required(&form, "target_host")?.trim().to_owned(),
            target_port: parse_u16(&form, "target_port")?,
            audio: current.audio,
        };
        save(&state_for_setup, next)?;
        reboot_response(request)
    })?;

    // Audio params take effect after the reboot re-applies the codec config.
    let state_for_audio = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/audio", Method::Post, move |mut request| {
        let form = form(&mut request)?;
        let current = state_for_audio
            .config
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .clone();
        let next = RuntimeConfig {
            audio: AudioSettings {
                input_line: InputLine::try_from(parse_u8(&form, "line")?)
                    .map_err(|_| anyhow!("line must be 1 or 2"))?,
                input_gain: parse_u8(&form, "gain")?,
                adc_attenuation_db: parse_u8(&form, "atten")?,
            },
            ..current
        };
        save(&state_for_audio, next)?;
        reboot_response(request)
    })?;

    server.fn_handler::<anyhow::Error, _>("/api/reset", Method::Post, move |request| {
        state
            .store
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .clear()?;
        reboot_response(request)
    })?;
    Ok(server)
}

fn save(state: &ApiState, config: RuntimeConfig) -> Result<()> {
    config
        .validate()
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save(&config)?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = config;
    Ok(())
}

fn reboot_response<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    respond(
        request,
        200,
        "application/json",
        r#"{"ok":true,"rebooting":true}"#,
    )?;
    // Let the HTTP server flush the response before replacing the process.
    esp_idf_svc::hal::delay::FreeRtos::delay_ms(500);
    unsafe { esp_idf_svc::sys::esp_restart() };
}

fn respond<C>(
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

fn form<C>(request: &mut embedded_svc::http::server::Request<C>) -> Result<BTreeMap<String, String>>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    let length = request.content_len().unwrap_or(0) as usize;
    if length > MAX_REQUEST_BYTES {
        bail!("request is too large");
    }
    let mut body = vec![0; length];
    request.read_exact(&mut body)?;
    parse_form(std::str::from_utf8(&body).map_err(|_| anyhow!("form is not UTF-8"))?)
}

fn parse_form(body: &str) -> Result<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for pair in body.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        result.insert(decode_form(key)?, decode_form(value)?);
    }
    Ok(result)
}

fn decode_form(value: &str) -> Result<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let source = value.as_bytes();
    let mut index = 0;
    while index < source.len() {
        match source[index] {
            b'+' => bytes.push(b' '),
            b'%' if index + 2 < source.len() => {
                bytes.push((hex(source[index + 1])? << 4) | hex(source[index + 2])?);
                index += 2;
            }
            b'%' => bail!("incomplete percent escape"),
            value => bytes.push(value),
        }
        index += 1;
    }
    String::from_utf8(bytes).map_err(Into::into)
}

fn hex(value: u8) -> Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => bail!("invalid percent escape"),
    }
}

fn required<'a>(form: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str> {
    form.get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("{key} is required"))
}

fn parse_u8(form: &BTreeMap<String, String>, key: &str) -> Result<u8> {
    required(form, key)?
        .parse()
        .map_err(|_| anyhow!("{key} must be a number"))
}

fn parse_u16(form: &BTreeMap<String, String>, key: &str) -> Result<u16> {
    required(form, key)?
        .parse()
        .map_err(|_| anyhow!("{key} must be a number between 1 and 65535"))
}

#[derive(Serialize)]
struct ConfigResponse<'a> {
    ssid: &'a str,
    target_host: &'a str,
    target_port: u16,
    input_line: u8,
    input_gain: u8,
    adc_atten_db: u8,
    config_source: &'a str,
}

#[derive(Serialize)]
struct StatusResponse<'a> {
    firmware_version: &'a str,
    mode: &'a str,
    config_source: &'a str,
    web_server: bool,
    configuration_writable: bool,
    wifi: WifiStatus<'a>,
    target: TargetStatus<'a>,
    audio: AudioStatus,
    metrics: MetricsStatus,
}

#[derive(Serialize)]
struct WifiStatus<'a> {
    ssid: &'a str,
    status: &'a str,
    sta_ip: &'a str,
    ap_ip: &'a str,
    rssi: i32,
}

#[derive(Serialize)]
struct TargetStatus<'a> {
    target_host: &'a str,
    target_port: u16,
    transport: &'a str,
}

#[derive(Serialize)]
struct AudioStatus {
    input_line: u8,
    input_gain: u8,
    adc_atten_db: u8,
    sample_rate: u32,
    channels: u8,
    bits_per_sample: u8,
}

#[derive(Serialize)]
struct MetricsStatus {
    sequence: u32,
    packets: u32,
    bytes: u32,
    read_errors: u32,
    short_reads: u32,
    queue_depth: u32,
    queue_drops_total: u32,
    network_errors_total: u32,
    reconnects_total: u32,
    clip_threshold_abs: u16,
    peak_abs_left: u32,
    peak_abs_right: u32,
    rms_left: u32,
    rms_right: u32,
    clipped_samples_total: u32,
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&ConfigResponse {
        ssid: &config.ssid,
        target_host: &config.target_host,
        target_port: config.target_port,
        input_line: line(config.audio.input_line),
        input_gain: config.audio.input_gain,
        adc_atten_db: config.audio.adc_attenuation_db,
        config_source: "nvs",
    })
}

fn status_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    let metrics = state
        .stream
        .as_ref()
        .map(|stream| stream.snapshot())
        .unwrap_or_default();
    let (mode, wifi_status) = match state.mode {
        Mode::SetupAp => ("setup-ap", "ap"),
        Mode::Streaming => ("streaming", "connected"),
    };
    serialize(&StatusResponse {
        firmware_version: env!("CARGO_PKG_VERSION"),
        mode,
        config_source: "nvs",
        web_server: true,
        configuration_writable: true,
        wifi: WifiStatus {
            ssid: &config.ssid,
            status: wifi_status,
            sta_ip: "",
            ap_ip: "",
            rssi: 0,
        },
        target: TargetStatus {
            target_host: &config.target_host,
            target_port: config.target_port,
            transport: "tcp",
        },
        audio: AudioStatus {
            input_line: line(config.audio.input_line),
            input_gain: config.audio.input_gain,
            adc_atten_db: config.audio.adc_attenuation_db,
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 16,
        },
        metrics: MetricsStatus {
            sequence: metrics.sequence,
            packets: metrics.packets,
            bytes: metrics.bytes,
            read_errors: metrics.read_errors,
            short_reads: metrics.short_reads,
            queue_depth: metrics.queue_depth,
            queue_drops_total: metrics.queue_drops,
            network_errors_total: metrics.network_errors,
            reconnects_total: metrics.reconnects,
            clip_threshold_abs: CLIP_THRESHOLD_ABS,
            peak_abs_left: metrics.peak_left,
            peak_abs_right: metrics.peak_right,
            rms_left: metrics.rms_left,
            rms_right: metrics.rms_right,
            clipped_samples_total: metrics.clipped_total,
        },
    })
}

/// Serialize an owned response built entirely from primitives and `&str`, which
/// `serde_json` never fails to encode.
fn serialize<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("response is always serializable")
}

const fn line(line: InputLine) -> u8 {
    match line {
        InputLine::One => 1,
        InputLine::Two => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_form;

    #[test]
    fn decodes_browser_urlencoded_forms() {
        let form = parse_form("ssid=Studio+WiFi&target_host=bridge%2Elocal").expect("valid form");
        assert_eq!(form["ssid"], "Studio WiFi");
        assert_eq!(form["target_host"], "bridge.local");
    }
}
