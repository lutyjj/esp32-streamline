//! Local provisioning and read-only runtime HTTP API.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use embedded_svc::{
    http::{Headers, Method},
    io::{Read, Write},
};
use esp_idf_svc::http::server::{Configuration, EspHttpServer};
use serde::{de::DeserializeOwned, Serialize};

use crate::{
    adapters::{
        codec::CodecControl,
        mdns::MdnsAdvertisement,
        nvs::ConfigStore,
        ota::{self, OtaProgress},
        wifi,
    },
    api::{
        self, Ack, AdminKeyForm, AudioSettingsForm, DeviceConfig, DeviceNameForm, DeviceStatus,
        ErrorResponse, HttpMethod, NetworkSettingsForm, OtaUpdateForm,
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

const INDEX: &str = include_str!("../../../../console/dist/index.html");
const OPENAPI_JSON: &str = include_str!("../../../../docs/openapi.json");
const MAX_REQUEST_BYTES: usize = 512;
const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

/// The boot contract: the one decision made at startup that fixes which
/// services run and who may write until the next reboot.
///
/// A state earns a variant here only if it changes the service set or the
/// trust model, and only at boot. Anything that changes at runtime is status
/// (`metrics.playing`, `ota.phase`); anything that is a configuration
/// difference reads from config (an empty `target_host` is "no bridge yet",
/// not a mode).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// Unconfigured: own open AP, writes accepted so a first admin key can be
    /// set. Capture and streaming are down.
    Setup,
    /// Station on the home network: console behind the admin key, capture
    /// running; the TCP stream runs only while a bridge target is configured.
    Provisioned,
}

pub struct ApiState {
    pub mode: Mode,
    pub hostname: String,
    pub config: Arc<Mutex<RuntimeConfig>>,
    pub store: Arc<Mutex<ConfigStore>>,
    pub stream: Option<Arc<StreamStatus>>,
    /// Live codec control, present when provisioned so audio settings apply
    /// without a reboot. Absent in setup mode, where the codec is not
    /// running.
    pub codec: Option<Arc<Mutex<CodecControl<'static>>>>,
    pub mdns: Option<Arc<Mutex<MdnsAdvertisement>>>,
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

    server.fn_handler(
        api::OPENAPI_ENDPOINT.path,
        http_method(api::OPENAPI_ENDPOINT.method),
        move |request| respond(request, 200, "application/json", OPENAPI_JSON),
    )?;

    let state_for_status = Arc::clone(&state);
    server.fn_handler(
        api::STATUS_ENDPOINT.path,
        http_method(api::STATUS_ENDPOINT.method),
        move |request| {
            respond(
                request,
                200,
                "application/json",
                &status_json(&state_for_status),
            )
        },
    )?;

    let state_for_metrics = Arc::clone(&state);
    server.fn_handler(
        api::METRICS_ENDPOINT.path,
        http_method(api::METRICS_ENDPOINT.method),
        move |request| {
            respond(
                request,
                200,
                PROMETHEUS_CONTENT_TYPE,
                &metrics_text(&state_for_metrics),
            )
        },
    )?;

    let state_for_config = Arc::clone(&state);
    server.fn_handler(
        api::SETTINGS_ENDPOINT.path,
        http_method(api::SETTINGS_ENDPOINT.method),
        move |request| {
            respond(
                request,
                200,
                "application/json",
                &config_json(&state_for_config),
            )
        },
    )?;

    // Mutating endpoints require the admin key once one is provisioned (see
    // `authorized`); an unconfigured device accepts setup writes so the first
    // key can be set. A Wi-Fi/target change reboots the device so it reconnects
    // with the new settings, which keeps swapping the stream target during testing
    // cheap.
    let state_for_setup = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::NETWORK_SETTINGS_ENDPOINT.path,
        http_method(api::NETWORK_SETTINGS_ENDPOINT.method),
        move |mut request| {
            if !authorized(&request, &state_for_setup) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form: NetworkSettingsForm = form(&mut request)?;
                let current = state_for_setup
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                let password = if form.password.is_empty() {
                    current.password
                } else {
                    form.password
                };
                // The admin key is preserved when left blank, just like the password, so a
                // routine Wi-Fi/target change does not require retyping it.
                let admin_secret = if form.admin_secret.is_empty() {
                    current.admin_secret
                } else {
                    form.admin_secret
                };
                let next = RuntimeConfig {
                    ssid: form.ssid,
                    password,
                    // Optional: commissioning sets Wi-Fi first and the bridge
                    // target later, so an absent or blank host means "no
                    // bridge yet" and the device boots into no-target mode.
                    target_host: form.target_host.trim().to_owned(),
                    target_port: form.target_port,
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
        api::AUDIO_SETTINGS_ENDPOINT.path,
        http_method(api::AUDIO_SETTINGS_ENDPOINT.method),
        move |mut request| {
            if !authorized(&request, &state_for_audio) {
                return unauthorized(request);
            }
            // Ok(true) means the settings were applied live.
            let result = (|| -> Result<bool> {
                let form: AudioSettingsForm = form(&mut request)?;
                let current = state_for_audio
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                let audio = AudioSettings {
                    input_line: InputLine::try_from(form.line)
                        .map_err(|_| anyhow!("line must be 1 or 2"))?,
                    input_gain: form.gain,
                    adc_attenuation_db: form.atten,
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
                Ok(true) => respond_json(request, 200, &Ack::ok()),
                Ok(false) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // The friendly device name only labels the console and browser tab, so it
    // applies immediately — no reboot. Blank clears the name.
    let state_for_name = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::DEVICE_NAME_ENDPOINT.path,
        http_method(api::DEVICE_NAME_ENDPOINT.method),
        move |mut request| {
            if !authorized(&request, &state_for_name) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form: DeviceNameForm = form(&mut request)?;
                let mut next = state_for_name
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                next.device_name = form.name.trim().to_owned();
                save(&state_for_name, next.clone())?;
                refresh_mdns_name(&state_for_name, &next);
                Ok(())
            })();
            match result {
                Ok(()) => respond_json(request, 200, &Ack::ok()),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    let state_for_admin_key = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::ADMIN_KEY_ENDPOINT.path,
        http_method(api::ADMIN_KEY_ENDPOINT.method),
        move |mut request| {
            if !authorized(&request, &state_for_admin_key) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form: AdminKeyForm = form(&mut request)?;
                let mut next = state_for_admin_key
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                next.admin_secret = form.admin_secret;
                save(&state_for_admin_key, next)
            })();
            match result {
                Ok(()) => respond_json(request, 200, &Ack::ok()),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // Check GitHub for a newer release without installing it. The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for the
    // outcome (`up-to-date` or `update-available`).
    let state_for_check = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::OTA_CHECK_ENDPOINT.path,
        http_method(api::OTA_CHECK_ENDPOINT.method),
        move |request| {
            if !authorized(&request, &state_for_check) {
                return unauthorized(request);
            }
            ota_accepted(request, ota::spawn_check(Arc::clone(&state_for_check.ota)))
        },
    )?;

    // Flash an image to the inactive OTA slot. An empty body pulls the latest
    // GitHub release; `url` + `sha256` form fields install that exact pinned
    // image instead (development installs, see docs/ota.md). The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for
    // progress, and the device reboots into the new image on success.
    let state_for_ota = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::OTA_UPDATE_ENDPOINT.path,
        http_method(api::OTA_UPDATE_ENDPOINT.method),
        move |mut request| {
            if !authorized(&request, &state_for_ota) {
                return unauthorized(request);
            }
            let form: OtaUpdateForm = match form(&mut request) {
                Ok(form) => form,
                Err(error) => return bad_request(request, error),
            };
            let source =
                match update::custom_image_from_form(form.url.as_deref(), form.sha256.as_deref()) {
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
    server.fn_handler::<anyhow::Error, _>(
        api::UNLOCK_ENDPOINT.path,
        http_method(api::UNLOCK_ENDPOINT.method),
        move |request| {
            if !authorized(&request, &state_for_unlock) {
                return unauthorized(request);
            }
            respond_json(request, 200, &Ack::ok())
        },
    )?;

    // Plain reboot with settings intact — recovers a wedged stream without a
    // trip to the power plug.
    let state_for_restart = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        api::RESTART_ENDPOINT.path,
        http_method(api::RESTART_ENDPOINT.method),
        move |request| {
            if !authorized(&request, &state_for_restart) {
                return unauthorized(request);
            }
            reboot_response(request)
        },
    )?;

    server.fn_handler::<anyhow::Error, _>(
        api::FACTORY_RESET_ENDPOINT.path,
        http_method(api::FACTORY_RESET_ENDPOINT.method),
        move |request| {
            if !authorized(&request, &state) {
                return unauthorized(request);
            }
            state
                .store
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clear()?;
            reboot_response(request)
        },
    )?;
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

fn refresh_mdns_name(state: &ApiState, config: &RuntimeConfig) {
    let Some(mdns) = &state.mdns else {
        return;
    };
    match mdns.lock() {
        Ok(mut advertisement) => {
            if let Err(error) = advertisement.set_instance_name(config) {
                log::warn!("could not refresh mDNS instance name: {error:#}");
            }
        }
        Err(_) => log::warn!("could not refresh mDNS instance name: lock poisoned"),
    }
}

fn http_method(method: HttpMethod) -> Method {
    match method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    }
}

fn reboot_response<C>(request: embedded_svc::http::server::Request<C>) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    respond_json(request, 200, &Ack::rebooting())?;
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

fn respond_json<C, T>(
    request: embedded_svc::http::server::Request<C>,
    code: u16,
    body: &T,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: Serialize,
{
    respond(request, code, "application/json", &serialize(body))
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
        Ok(()) => respond_json(request, 202, &Ack::started()),
        Err(error) => respond_json(request, 409, &ErrorResponse::new(error.to_string())),
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
    respond_json(request, 401, &ErrorResponse::new("unauthorized"))
}

fn bad_request<C>(
    request: embedded_svc::http::server::Request<C>,
    error: anyhow::Error,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    respond_json(request, 400, &ErrorResponse::new(error.to_string()))
}

fn form<C, T>(request: &mut embedded_svc::http::server::Request<C>) -> Result<T>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: DeserializeOwned,
{
    let length = request.content_len().unwrap_or(0) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(anyhow!("request is too large"));
    }
    let mut body = vec![0; length];
    request.read_exact(&mut body)?;
    api::parse_form(&body).map_err(anyhow::Error::msg)
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&DeviceConfig::from_runtime(&config))
}

fn status_json(state: &ApiState) -> String {
    let snapshot = telemetry_snapshot(state);
    serialize(&DeviceStatus::from_snapshot(&snapshot))
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
        Mode::Setup => ("setup", "ap"),
        Mode::Provisioned => ("provisioned", "connected"),
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
            hostname: state.hostname.clone(),
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

/// Serialize response DTOs, which contain only primitives, strings, and nested DTOs.
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
