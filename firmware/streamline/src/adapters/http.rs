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
    adapters::{
        codec::CodecControl,
        nvs::ConfigStore,
        ota::{self, OtaProgress},
        wifi,
    },
    config::{AudioSettings, InputLine, RuntimeConfig},
    levels::CLIP_THRESHOLD_ABS,
    metrics::render_prometheus,
    runtime::StreamStatus,
    telemetry::{
        AudioTelemetry, DiagnosticsTelemetry, OtaTelemetry, StreamTelemetry, TargetTelemetry,
        TelemetrySnapshot, WifiTelemetry,
    },
    update,
};

const INDEX: &str = include_str!("../../web/index.html");
const APP_CSS: &str = include_str!("../../web/app.css");
const APP_JS: &str = include_str!("../../web/app.js");
const MAX_REQUEST_BYTES: usize = 512;
const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

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
    /// Live codec control, present while streaming so audio settings apply
    /// without a reboot. Absent in setup-AP mode, where the codec is not
    /// running.
    pub codec: Option<Arc<Mutex<CodecControl<'static>>>>,
    pub ota: Arc<OtaProgress>,
}

pub fn start(state: Arc<ApiState>) -> Result<EspHttpServer<'static>> {
    let mut server = EspHttpServer::new(&Configuration {
        stack_size: 8_192,
        ..Default::default()
    })?;
    server.fn_handler("/", Method::Get, move |request| {
        respond(request, 200, "text/html; charset=utf-8", INDEX)
    })?;
    server.fn_handler("/app.css", Method::Get, move |request| {
        respond(request, 200, "text/css; charset=utf-8", APP_CSS)
    })?;
    server.fn_handler("/app.js", Method::Get, move |request| {
        respond(request, 200, "text/javascript; charset=utf-8", APP_JS)
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

    let state_for_metrics = Arc::clone(&state);
    server.fn_handler("/api/metrics", Method::Get, move |request| {
        respond(
            request,
            200,
            PROMETHEUS_CONTENT_TYPE,
            &metrics_text(&state_for_metrics),
        )
    })?;

    let state_for_config = Arc::clone(&state);
    server.fn_handler("/api/settings", Method::Get, move |request| {
        respond(
            request,
            200,
            "application/json",
            &config_json(&state_for_config),
        )
    })?;

    // Mutating endpoints require the admin key once one is provisioned (see
    // `authorized`); an unconfigured device accepts setup writes so the first
    // key can be set. A Wi-Fi/target change reboots the device so it reconnects
    // with the new settings, which keeps swapping the stream target during testing
    // cheap.
    let state_for_setup = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/network",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_setup) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
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
                // The admin key is preserved when left blank, just like the password, so a
                // routine Wi-Fi/target change does not require retyping it.
                let admin_secret = form
                    .get("admin_secret")
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .unwrap_or(current.admin_secret);
                let next = RuntimeConfig {
                    ssid: required(&form, "ssid")?.to_owned(),
                    password,
                    target_host: required(&form, "target_host")?.trim().to_owned(),
                    target_port: parse_u16(&form, "target_port")?,
                    admin_secret,
                    device_name: current.device_name,
                    audio: current.audio,
                };
                save(&state_for_setup, next)
            })();
            match result {
                Ok(()) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // While streaming, audio params are written straight to the running codec
    // and play detection re-baselines to the new input scale — no reboot. In
    // setup-AP mode the codec is not running, so the settings are persisted
    // and take effect when the device boots into streaming.
    let state_for_audio = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/audio",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_audio) {
                return unauthorized(request);
            }
            // Ok(true) means the settings were applied live.
            let result = (|| -> Result<bool> {
                let form = form(&mut request)?;
                let current = state_for_audio
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                let audio = AudioSettings {
                    input_line: InputLine::try_from(parse_u8(&form, "line")?)
                        .map_err(|_| anyhow!("line must be 1 or 2"))?,
                    input_gain: parse_u8(&form, "gain")?,
                    adc_attenuation_db: parse_u8(&form, "atten")?,
                };
                save(&state_for_audio, RuntimeConfig { audio, ..current })?;
                let Some(codec) = &state_for_audio.codec else {
                    return Ok(false);
                };
                // The settings are already persisted: if the live write fails, a
                // reboot re-applies them from storage.
                codec
                    .lock()
                    .map_err(|_| anyhow!("codec lock poisoned"))?
                    .apply(audio)?;
                if let Some(stream) = &state_for_audio.stream {
                    stream.request_relearn();
                }
                Ok(true)
            })();
            match result {
                Ok(true) => respond(request, 200, "application/json", r#"{"ok":true}"#),
                Ok(false) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // The friendly device name only labels the console and browser tab, so it
    // applies immediately — no reboot. Blank clears the name.
    let state_for_name = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/name",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_name) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let mut next = state_for_name
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                next.device_name = form
                    .get("name")
                    .map(|value| value.trim().to_owned())
                    .unwrap_or_default();
                save(&state_for_name, next)
            })();
            match result {
                Ok(()) => respond(request, 200, "application/json", r#"{"ok":true}"#),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    let state_for_admin_key = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/admin-key",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_admin_key) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let mut next = state_for_admin_key
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                next.admin_secret = required(&form, "admin_secret")?.to_owned();
                save(&state_for_admin_key, next)
            })();
            match result {
                Ok(()) => respond(request, 200, "application/json", r#"{"ok":true}"#),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // Check GitHub for a newer release without installing it. The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for the
    // outcome (`up-to-date` or `update-available`).
    let state_for_check = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/ota/check", Method::Post, move |request| {
        if !authorized(&request, &state_for_check) {
            return unauthorized(request);
        }
        ota_accepted(request, ota::spawn_check(Arc::clone(&state_for_check.ota)))
    })?;

    // Flash an image to the inactive OTA slot. An empty body pulls the latest
    // GitHub release; `url` + `sha256` form fields install that exact pinned
    // image instead (development installs, see docs/ota.md). The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for
    // progress, and the device reboots into the new image on success.
    let state_for_ota = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/ota/update",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_ota) {
                return unauthorized(request);
            }
            let form = match form(&mut request) {
                Ok(form) => form,
                Err(error) => return bad_request(request, error),
            };
            let source = match update::custom_image_from_form(
                form.get("url").map(String::as_str),
                form.get("sha256").map(String::as_str),
            ) {
                Ok(None) => ota::Source::LatestRelease,
                Ok(Some(image)) => ota::Source::Custom(image),
                Err(error) => return bad_request(request, anyhow!(error)),
            };
            ota_accepted(
                request,
                ota::spawn_update(
                    Arc::clone(&state_for_ota.ota),
                    Arc::clone(&state_for_ota.store),
                    source,
                ),
            )
        },
    )?;

    // Verify an admin key without changing anything, so the console can reject
    // a wrong key at unlock time instead of on the first settings write.
    let state_for_unlock = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/unlock", Method::Post, move |request| {
        if !authorized(&request, &state_for_unlock) {
            return unauthorized(request);
        }
        respond(request, 200, "application/json", r#"{"ok":true}"#)
    })?;

    // Plain reboot with settings intact — recovers a wedged stream without a
    // trip to the power plug.
    let state_for_restart = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/restart", Method::Post, move |request| {
        if !authorized(&request, &state_for_restart) {
            return unauthorized(request);
        }
        reboot_response(request)
    })?;

    server.fn_handler::<anyhow::Error, _>("/api/factory-reset", Method::Post, move |request| {
        if !authorized(&request, &state) {
            return unauthorized(request);
        }
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

/// Answer an OTA trigger: `202` once the background worker is running, or `409`
/// with the reason if one is already in progress.
fn ota_accepted<C>(
    request: embedded_svc::http::server::Request<C>,
    spawned: anyhow::Result<()>,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    match spawned {
        Ok(()) => respond(
            request,
            202,
            "application/json",
            r#"{"ok":true,"started":true}"#,
        ),
        Err(error) => {
            let body = format!(
                r#"{{"error":{}}}"#,
                serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"update unavailable\"".to_owned())
            );
            respond(request, 409, "application/json", &body)
        }
    }
}

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

fn unauthorized<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    respond(
        request,
        401,
        "application/json",
        r#"{"error":"unauthorized"}"#,
    )
}

fn bad_request<C>(
    request: embedded_svc::http::server::Request<C>,
    error: anyhow::Error,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    let message =
        serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"bad request\"".to_owned());
    respond(
        request,
        400,
        "application/json",
        &format!(r#"{{"error":{message}}}"#),
    )
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
    device_name: &'a str,
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
    device_name: &'a str,
    mode: &'a str,
    config_source: &'a str,
    web_server: bool,
    configuration_writable: bool,
    auth_required: bool,
    wifi: WifiStatus<'a>,
    target: TargetStatus<'a>,
    audio: AudioStatus,
    metrics: MetricsStatus,
    diagnostics: DiagnosticsStatus<'a>,
    ota: OtaStatus<'a>,
}

/// Post-mortem evidence for boots the user did not watch: why the device is
/// (or last was) in setup-AP mode, how the last OTA attempt ended, and what
/// kind of reset produced this boot.
#[derive(Serialize)]
struct DiagnosticsStatus<'a> {
    reset_reason: &'a str,
    last_fallback: &'a str,
    last_ota: &'a str,
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
    packets: u64,
    bytes: u64,
    read_errors: u64,
    short_reads: u64,
    queue_depth: u32,
    queue_drops_total: u64,
    network_errors_total: u64,
    reconnects_total: u64,
    clip_threshold_abs: u16,
    peak_abs_left: u32,
    peak_abs_right: u32,
    rms_left: u32,
    rms_right: u32,
    noise_floor: u32,
    clipped_samples_total: u64,
    playing: bool,
}

#[derive(Serialize)]
struct OtaStatus<'a> {
    phase: &'a str,
    bytes_written: u32,
    bytes_total: u32,
    latest_version: &'a str,
    message: &'a str,
    busy: bool,
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&ConfigResponse {
        device_name: &config.device_name,
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
    let snapshot = telemetry_snapshot(state);
    serialize(&StatusResponse::from(&snapshot))
}

fn metrics_text(state: &ApiState) -> String {
    render_prometheus(&telemetry_snapshot(state))
}

fn telemetry_snapshot(state: &ApiState) -> TelemetrySnapshot {
    let (last_fallback, last_ota) = match state.store.lock() {
        Ok(store) => (store.last_fallback(), store.last_ota()),
        Err(_) => (String::new(), String::new()),
    };
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
    let ota = state.ota.snapshot();
    TelemetrySnapshot {
        firmware_version: env!("CARGO_PKG_VERSION"),
        device_name: config.device_name.clone(),
        mode,
        config_source: "nvs",
        web_server: true,
        configuration_writable: true,
        auth_required: !config.admin_secret.is_empty(),
        wifi: WifiTelemetry {
            ssid: config.ssid.clone(),
            status: wifi_status,
            sta_ip: wifi::station_ip().unwrap_or_default(),
            ap_ip: wifi::access_point_ip().unwrap_or_default(),
            rssi_dbm: wifi::rssi().unwrap_or(0),
        },
        target: TargetTelemetry {
            host: config.target_host.clone(),
            port: config.target_port,
            transport: "tcp",
        },
        audio: AudioTelemetry {
            input_line: line(config.audio.input_line),
            input_gain: config.audio.input_gain,
            adc_attenuation_db: config.audio.adc_attenuation_db,
            sample_rate_hz: 48_000,
            channels: 2,
            bits_per_sample: 16,
            clip_threshold_abs: CLIP_THRESHOLD_ABS,
            peak_abs_left: metrics.peak_left,
            peak_abs_right: metrics.peak_right,
            rms_left: metrics.rms_left,
            rms_right: metrics.rms_right,
            noise_floor: metrics.noise_floor,
            clipped_samples_total: metrics.clipped_total,
            playing: metrics.playing,
        },
        stream: StreamTelemetry {
            sequence: metrics.sequence,
            packets_total: metrics.packets,
            bytes_total: metrics.bytes,
            read_errors_total: metrics.read_errors,
            short_reads_total: metrics.short_reads,
            queue_depth: metrics.queue_depth,
            queue_drops_total: metrics.queue_drops,
            network_errors_total: metrics.network_errors,
            reconnects_total: metrics.reconnects,
        },
        diagnostics: DiagnosticsTelemetry {
            reset_reason: reset_reason(),
            last_fallback,
            last_ota,
        },
        ota: OtaTelemetry {
            phase: ota.phase,
            bytes_written: ota.bytes_written,
            bytes_total: ota.bytes_total,
            latest_version: ota.latest_version,
            message: ota.message,
            busy: ota.busy,
        },
    }
}

/// What kind of reset produced this boot; `panic` or a watchdog value on a
/// crash, `power-on` on a power cycle, `software` after an OTA or config reboot.
fn reset_reason() -> &'static str {
    use esp_idf_svc::sys;
    match unsafe { sys::esp_reset_reason() } {
        sys::esp_reset_reason_t_ESP_RST_POWERON => "power-on",
        sys::esp_reset_reason_t_ESP_RST_EXT => "external-pin",
        sys::esp_reset_reason_t_ESP_RST_SW => "software",
        sys::esp_reset_reason_t_ESP_RST_PANIC => "panic",
        sys::esp_reset_reason_t_ESP_RST_INT_WDT => "interrupt-watchdog",
        sys::esp_reset_reason_t_ESP_RST_TASK_WDT => "task-watchdog",
        sys::esp_reset_reason_t_ESP_RST_WDT => "watchdog",
        sys::esp_reset_reason_t_ESP_RST_DEEPSLEEP => "deep-sleep-wake",
        sys::esp_reset_reason_t_ESP_RST_BROWNOUT => "brownout",
        sys::esp_reset_reason_t_ESP_RST_SDIO => "sdio",
        _ => "unknown",
    }
}

impl<'a> From<&'a TelemetrySnapshot> for StatusResponse<'a> {
    fn from(snapshot: &'a TelemetrySnapshot) -> Self {
        Self {
            firmware_version: snapshot.firmware_version,
            device_name: &snapshot.device_name,
            mode: snapshot.mode,
            config_source: snapshot.config_source,
            web_server: snapshot.web_server,
            configuration_writable: snapshot.configuration_writable,
            auth_required: snapshot.auth_required,
            wifi: WifiStatus {
                ssid: &snapshot.wifi.ssid,
                status: snapshot.wifi.status,
                sta_ip: &snapshot.wifi.sta_ip,
                ap_ip: &snapshot.wifi.ap_ip,
                rssi: snapshot.wifi.rssi_dbm,
            },
            target: TargetStatus {
                target_host: &snapshot.target.host,
                target_port: snapshot.target.port,
                transport: snapshot.target.transport,
            },
            audio: AudioStatus {
                input_line: snapshot.audio.input_line,
                input_gain: snapshot.audio.input_gain,
                adc_atten_db: snapshot.audio.adc_attenuation_db,
                sample_rate: snapshot.audio.sample_rate_hz,
                channels: snapshot.audio.channels,
                bits_per_sample: snapshot.audio.bits_per_sample,
            },
            metrics: MetricsStatus {
                sequence: snapshot.stream.sequence,
                packets: snapshot.stream.packets_total,
                bytes: snapshot.stream.bytes_total,
                read_errors: snapshot.stream.read_errors_total,
                short_reads: snapshot.stream.short_reads_total,
                queue_depth: snapshot.stream.queue_depth,
                queue_drops_total: snapshot.stream.queue_drops_total,
                network_errors_total: snapshot.stream.network_errors_total,
                reconnects_total: snapshot.stream.reconnects_total,
                clip_threshold_abs: snapshot.audio.clip_threshold_abs,
                peak_abs_left: snapshot.audio.peak_abs_left,
                peak_abs_right: snapshot.audio.peak_abs_right,
                rms_left: snapshot.audio.rms_left,
                rms_right: snapshot.audio.rms_right,
                noise_floor: snapshot.audio.noise_floor,
                clipped_samples_total: snapshot.audio.clipped_samples_total,
                playing: snapshot.audio.playing,
            },
            diagnostics: DiagnosticsStatus {
                reset_reason: snapshot.diagnostics.reset_reason,
                last_fallback: &snapshot.diagnostics.last_fallback,
                last_ota: &snapshot.diagnostics.last_ota,
            },
            ota: OtaStatus {
                phase: snapshot.ota.phase,
                bytes_written: snapshot.ota.bytes_written,
                bytes_total: snapshot.ota.bytes_total,
                latest_version: &snapshot.ota.latest_version,
                message: &snapshot.ota.message,
                busy: snapshot.ota.busy,
            },
        }
    }
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
    use super::{authorized_secret, constant_time_eq, parse_form};

    #[test]
    fn decodes_browser_urlencoded_forms() {
        let form = parse_form("ssid=Studio+WiFi&target_host=bridge%2Elocal").expect("valid form");
        assert_eq!(form["ssid"], "Studio WiFi");
        assert_eq!(form["target_host"], "bridge.local");
    }

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
