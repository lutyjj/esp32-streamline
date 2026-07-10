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
        codec::{self, CodecControl},
        mdns::MdnsAdvertisement,
        nvs::{ConfigStore, MAX_BOARD_DESCRIPTOR_BYTES},
        ota::{self, OtaProgress},
        wifi,
    },
    board,
    config::{AudioSettings, AutoUpdateSchedule, RuntimeConfig},
    health::{HealthReport, Severity},
    levels::CLIP_THRESHOLD_ABS,
    metrics::render_prometheus,
    profiles::AudioProfileCatalog,
    runtime::StreamStatus,
    telemetry::{
        AudioTelemetry, DiagnosticsTelemetry, OtaTelemetry, StreamTelemetry, TargetTelemetry,
        TelemetrySnapshot, WifiTelemetry,
    },
    update,
};

const INDEX: &str = include_str!("../../../../console/dist/index.html");
/// A form-urlencoded byte can expand to `%XX`, so a descriptor upload can be
/// three times its raw size on the wire; the rest of the fields fit in 512.
const URL_ENCODED_EXPANSION: usize = 3;
const MAX_REQUEST_BYTES: usize = MAX_BOARD_DESCRIPTOR_BYTES * URL_ENCODED_EXPANSION + 512;
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
    pub board_catalog: Arc<Vec<board::Board>>,
    pub board: Arc<board::Board>,
    pub config: Arc<Mutex<RuntimeConfig>>,
    pub audio_profiles: Arc<Mutex<AudioProfileCatalog>>,
    pub store: Arc<Mutex<ConfigStore>>,
    pub stream: Option<Arc<StreamStatus>>,
    /// Live codec control, present when provisioned so audio settings apply
    /// without a reboot. Absent in setup mode, where the codec is not
    /// running.
    pub codec: Option<Arc<Mutex<CodecControl<'static>>>>,
    pub mdns: Option<Arc<Mutex<MdnsAdvertisement>>>,
    pub ota: Arc<OtaProgress>,
    /// The startup health verdict, assembled once at boot (see [`crate::health`]).
    pub health: Arc<HealthReport>,
    /// The version the inactive slot would roll back into, read once at boot;
    /// `None` when no valid previous image is stored. Fixed until the next OTA,
    /// which reboots and re-reads it.
    pub rollback: Option<String>,
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

    // A scriptable liveness probe: 200 when the startup checks found nothing
    // blocking, 503 when they did. The same verdict rides `/api/status` under
    // `health` for the console; this endpoint is the status code a monitor or
    // `curl` can read without parsing JSON.
    let state_for_health = Arc::clone(&state);
    server.fn_handler("/api/health", Method::Get, move |request| {
        let health = &state_for_health.health;
        let code = if health.status == Severity::Blocking {
            503
        } else {
            200
        };
        respond(
            request,
            code,
            "application/json",
            &serialize(health.as_ref()),
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

    let state_for_audio_profiles = Arc::clone(&state);
    server.fn_handler("/api/audio-profiles", Method::Get, move |request| {
        respond(
            request,
            200,
            "application/json",
            &audio_profiles_json(&state_for_audio_profiles),
        )
    })?;

    let state_for_boards = Arc::clone(&state);
    server.fn_handler("/api/boards", Method::Get, move |request| {
        respond(
            request,
            200,
            "application/json",
            &board_catalog_json(&state_for_boards),
        )
    })?;

    // Mutating endpoints require the admin key once one is provisioned (see
    // `authorized`); an unconfigured device accepts setup writes so the first
    // key can be set. Wi-Fi and the stream target are separate nouns: each write
    // validates and persists only its own fields, so a malformed target host
    // cannot fail a Wi-Fi save and a Wi-Fi save cannot smuggle in half-typed
    // target edits.
    let state_for_wifi = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/wifi",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_wifi) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let current = state_for_wifi
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
                // routine Wi-Fi change does not require retyping it.
                let admin_secret = form
                    .get("admin_secret")
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .unwrap_or(current.admin_secret);
                // Commissioning may set the initial stream target in the same
                // write, because the device reboots onto the home network right
                // after and the two cannot be posted separately. Absent target
                // fields are preserved, so a steady-state Wi-Fi change leaves the
                // target alone.
                let target_host = match form.get("target_host") {
                    Some(value) => value.trim().to_owned(),
                    None => current.target_host,
                };
                let target_port = match form.get("target_port") {
                    Some(_) => parse_u16(&form, "target_port")?,
                    None => current.target_port,
                };
                let next = RuntimeConfig {
                    ssid: required(&form, "ssid")?.to_owned(),
                    password,
                    target_host,
                    target_port,
                    admin_secret,
                    device_name: current.device_name,
                    auto_update_schedule: current.auto_update_schedule,
                    audio: current.audio,
                };
                save(&state_for_wifi, next)
            })();
            match result {
                Ok(()) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // The stream target is a stage-3 change, not commissioning: it sets only
    // host and port and leaves Wi-Fi and the admin key untouched. Blank host
    // clears the target ("no bridge yet"). A target change takes effect on the
    // next boot; applying it to the running stream without a reboot is deferred
    // (the stream target is fixed when the network task spawns).
    let state_for_target = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/target",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_target) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let current = state_for_target
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                let target_host = form
                    .get("target_host")
                    .map(|value| value.trim().to_owned())
                    .unwrap_or_default();
                let target_port = match form.get("target_port") {
                    Some(_) => parse_u16(&form, "target_port")?,
                    None => current.target_port,
                };
                let next = RuntimeConfig {
                    target_host,
                    target_port,
                    ..current
                };
                save(&state_for_target, next)
            })();
            match result {
                Ok(()) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    let state_for_board = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/board",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_board) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let update = board_update_from_form(&form, &state_for_board.board_catalog)?;
                let selected = update.board();
                let next = state_for_board
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone()
                    .with_audio_compatible_with(selected);

                let store = state_for_board
                    .store
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?;
                if state_for_board.mode == Mode::Provisioned {
                    next.validate(selected)
                        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
                }
                match &update {
                    BoardUpdate::BuiltIn(board) => store.save_built_in_board(board)?,
                    BoardUpdate::Custom(board) => store.save_custom_board(board)?,
                }
                store.clear_audio_profiles()?;
                if state_for_board.mode == Mode::Provisioned {
                    store.save(&next, selected)?;
                }
                *state_for_board
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))? = next;
                *state_for_board
                    .audio_profiles
                    .lock()
                    .map_err(|_| anyhow!("audio profile lock poisoned"))? =
                    AudioProfileCatalog::empty(selected);
                Ok(())
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
                    input_line: parse_u8(&form, "line")?,
                    input_gain: parse_u8(&form, "gain")?,
                    adc_attenuation_db: parse_u8(&form, "atten")?,
                }
                .validate(state_for_audio.board.as_ref())
                .map_err(|error| anyhow!("invalid audio settings: {error:?}"))?;
                save(&state_for_audio, RuntimeConfig { audio, ..current })?;
                clear_active_profile(&state_for_audio)?;
                apply_audio_live(&state_for_audio, audio)
            })();
            match result {
                Ok(true) => respond(request, 200, "application/json", r#"{"ok":true}"#),
                Ok(false) => reboot_response(request),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // The collection write replaces the typed profile catalog. Activation is
    // a separate setting below, so importing or editing profiles cannot change
    // live levels as a side effect.
    let state_for_profile_catalog = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/audio-profiles",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_profile_catalog) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let mut catalog: AudioProfileCatalog =
                    serde_json::from_str(required(&form, "catalog")?)
                        .map_err(|error| anyhow!("invalid audio profile catalog: {error}"))?;
                // Collection writes manage definitions only. Preserve the
                // device's selected profile when it still exists; the
                // singular endpoint below owns activation.
                catalog.active_profile_id = None;
                catalog
                    .validate(state_for_profile_catalog.board.as_ref())
                    .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
                let previous_active = state_for_profile_catalog
                    .audio_profiles
                    .lock()
                    .map_err(|_| anyhow!("audio profile lock poisoned"))?
                    .active_profile_id
                    .clone();
                catalog.active_profile_id = previous_active
                    .filter(|id| catalog.profiles.iter().any(|profile| &profile.id == id));
                let current_audio = state_for_profile_catalog
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .audio;
                catalog.reconcile_active_audio(current_audio);
                save_audio_profiles(&state_for_profile_catalog, catalog)
            })();
            match result {
                Ok(()) => respond(request, 200, "application/json", r#"{"ok":true}"#),
                Err(error) => bad_request(request, error),
            }
        },
    )?;

    // One stable activation contract serves the console and authoritative
    // external triggers such as Home Assistant or a source-selector GPIO.
    let state_for_active_profile = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/audio-profile",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_active_profile) {
                return unauthorized(request);
            }
            // Ok(true) means a selected profile was applied live. Selecting an
            // empty id returns to custom settings without changing levels.
            let result = (|| -> Result<bool> {
                let form = form(&mut request)?;
                let id = form.get("profile_id").map(String::as_str);
                let mut catalog = state_for_active_profile
                    .audio_profiles
                    .lock()
                    .map_err(|_| anyhow!("audio profile lock poisoned"))?
                    .clone();
                let audio = catalog
                    .activate(id)
                    .map_err(|error| anyhow!("invalid active audio profile: {error:?}"))?;
                if let Some(audio) = audio {
                    let current = state_for_active_profile
                        .config
                        .lock()
                        .map_err(|_| anyhow!("configuration lock poisoned"))?
                        .clone();
                    save(
                        &state_for_active_profile,
                        RuntimeConfig { audio, ..current },
                    )?;
                    save_audio_profiles(&state_for_active_profile, catalog)?;
                    return apply_audio_live(&state_for_active_profile, audio);
                }
                save_audio_profiles(&state_for_active_profile, catalog)?;
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
                save(&state_for_name, next.clone())?;
                refresh_mdns_name(&state_for_name, &next);
                Ok(())
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

    // Firmware maintenance is a live policy setting. The boot loop reads the
    // shared config before each scheduled attempt, so changing it needs no
    // reboot and the OTA worker remains the single installation path.
    let state_for_firmware = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>(
        "/api/settings/firmware",
        Method::Post,
        move |mut request| {
            if !authorized(&request, &state_for_firmware) {
                return unauthorized(request);
            }
            let result = (|| -> Result<()> {
                let form = form(&mut request)?;
                let auto_update_schedule =
                    AutoUpdateSchedule::parse(required(&form, "auto_update_schedule")?)
                        .ok_or_else(|| {
                            anyhow!("auto_update_schedule must be disabled, daily, or weekly")
                        })?;
                let current = state_for_firmware
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                let next = RuntimeConfig {
                    auto_update_schedule,
                    ..current
                };
                if state_for_firmware.mode == Mode::Provisioned {
                    save(&state_for_firmware, next)
                } else {
                    *state_for_firmware
                        .config
                        .lock()
                        .map_err(|_| anyhow!("configuration lock poisoned"))? = next;
                    Ok(())
                }
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

    // Roll back to the previous firmware by booting the other slot — instant and
    // offline, no re-download. Flip the boot selection first so an unavailable
    // rollback returns an error instead of a false "rebooting"; the device then
    // reboots into the previous image, which its boot path re-confirms.
    let state_for_rollback = Arc::clone(&state);
    server.fn_handler::<anyhow::Error, _>("/api/ota/rollback", Method::Post, move |request| {
        if !authorized(&request, &state_for_rollback) {
            return unauthorized(request);
        }
        match ota::select_rollback_slot() {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })?;

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
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save(&config, state.board.as_ref())?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = config;
    Ok(())
}

fn save_audio_profiles(state: &ApiState, catalog: AudioProfileCatalog) -> Result<()> {
    catalog
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save_audio_profiles(&catalog, state.board.as_ref())?;
    *state
        .audio_profiles
        .lock()
        .map_err(|_| anyhow!("audio profile lock poisoned"))? = catalog;
    Ok(())
}

fn clear_active_profile(state: &ApiState) -> Result<()> {
    let mut catalog = state
        .audio_profiles
        .lock()
        .map_err(|_| anyhow!("audio profile lock poisoned"))?
        .clone();
    if catalog.active_profile_id.take().is_some() {
        save_audio_profiles(state, catalog)?;
    }
    Ok(())
}

/// Apply already-persisted audio settings to the running codec and reset play
/// detection to the new scale. `false` means setup mode must reboot to apply.
fn apply_audio_live(state: &ApiState, audio: AudioSettings) -> Result<bool> {
    let Some(codec) = &state.codec else {
        return Ok(false);
    };
    codec
        .lock()
        .map_err(|_| anyhow!("codec lock poisoned"))?
        .apply(audio)?;
    if let Some(stream) = &state.stream {
        stream.request_relearn();
    }
    Ok(true)
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

enum BoardUpdate {
    BuiltIn(board::Board),
    Custom(board::Board),
}

impl BoardUpdate {
    fn board(&self) -> &board::Board {
        match self {
            Self::BuiltIn(board) | Self::Custom(board) => board,
        }
    }
}

fn board_update_from_form(
    form: &BTreeMap<String, String>,
    catalog: &[board::Board],
) -> Result<BoardUpdate> {
    let board_id = form
        .get("board_id")
        .map(String::as_str)
        .filter(|id| !id.is_empty());
    let descriptor_json = form
        .get("descriptor")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    match (board_id, descriptor_json) {
        (Some(_), Some(_)) => bail!("send either board_id or descriptor, not both"),
        (Some(id), None) => {
            let board = board::find(catalog, id)
                .ok_or_else(|| anyhow!("unknown board descriptor '{id}'"))?
                .clone();
            Ok(BoardUpdate::BuiltIn(board))
        }
        (None, Some(json)) => {
            if json.len() > MAX_BOARD_DESCRIPTOR_BYTES {
                bail!(
                    "board descriptor is too large: {} bytes, max {}",
                    json.len(),
                    MAX_BOARD_DESCRIPTOR_BYTES
                );
            }
            let board = board::parse_descriptor(json)
                .map_err(|error| anyhow!("invalid board descriptor: {error}"))?;
            // One id names one board. A custom descriptor may not reuse a
            // built-in id, or the boot-time selection would be ambiguous and
            // the built-in would silently shadow the upload.
            if board::find(catalog, &board.id).is_some() {
                bail!(
                    "board descriptor id '{}' is a built-in; choose a different id for a custom board",
                    board.id
                );
            }
            codec::validate_supported(&board.codec)?;
            Ok(BoardUpdate::Custom(board))
        }
        (None, None) => bail!("board_id or descriptor is required"),
    }
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
    auto_update_schedule: &'a str,
    config_source: &'a str,
}

#[derive(Serialize)]
struct BoardCatalogResponse<'a> {
    selected_board_id: &'a str,
    selected_board: CapabilitiesStatus<'a>,
    boards: Vec<CapabilitiesStatus<'a>>,
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
    capabilities: CapabilitiesStatus<'a>,
    wifi: WifiStatus<'a>,
    target: TargetStatus<'a>,
    audio: AudioStatus,
    metrics: MetricsStatus,
    diagnostics: DiagnosticsStatus<'a>,
    ota: OtaStatus<'a>,
    /// Startup health verdict; mirrors `health` in `console/src/lib/api.ts`.
    health: &'a HealthReport,
}

/// The resolved board's facts, from its descriptor in [`crate::board`]; the
/// console renders its audio controls from this. Mirrors `capabilities` in
/// `console/src/lib/api.ts`.
#[derive(Serialize)]
struct CapabilitiesStatus<'a> {
    board_id: &'a str,
    board: &'a str,
    codec: CodecStatus<'a>,
    pins: PinMapStatus,
    input_lines: Vec<InputLineStatus<'a>>,
    input_gain_max: u8,
    adc_atten_max_db: u8,
}

#[derive(Serialize)]
struct CodecStatus<'a> {
    driver: &'a str,
    i2c_address: u8,
}

#[derive(Serialize)]
struct PinMapStatus {
    i2c: I2cPinsStatus,
    i2s: I2sPinsStatus,
}

#[derive(Serialize)]
struct I2cPinsStatus {
    sda: u8,
    scl: u8,
}

#[derive(Serialize)]
struct I2sPinsStatus {
    mclk: u8,
    bclk: u8,
    ws: u8,
    din: u8,
}

#[derive(Serialize)]
struct InputLineStatus<'a> {
    line: u8,
    label: &'a str,
}

impl<'a> CapabilitiesStatus<'a> {
    fn from_board(board: &'a board::Board) -> Self {
        Self {
            board_id: board.id.as_str(),
            board: board.name.as_str(),
            codec: CodecStatus {
                driver: board.codec.driver.as_str(),
                i2c_address: board.codec.i2c_address,
            },
            pins: PinMapStatus {
                i2c: I2cPinsStatus {
                    sda: board.pins.i2c.sda,
                    scl: board.pins.i2c.scl,
                },
                i2s: I2sPinsStatus {
                    mclk: board.pins.i2s.mclk,
                    bclk: board.pins.i2s.bclk,
                    ws: board.pins.i2s.ws,
                    din: board.pins.i2s.din,
                },
            },
            input_lines: board
                .input_lines
                .iter()
                .map(|option| InputLineStatus {
                    line: option.line,
                    label: option.label.as_str(),
                })
                .collect(),
            input_gain_max: board.input_gain_max,
            adc_atten_max_db: board.adc_atten_max_db,
        }
    }
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
    hostname: &'a str,
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
    rollback_available: bool,
    rollback_version: &'a str,
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&ConfigResponse {
        device_name: &config.device_name,
        ssid: &config.ssid,
        target_host: &config.target_host,
        target_port: config.target_port,
        input_line: config.audio.input_line,
        input_gain: config.audio.input_gain,
        adc_atten_db: config.audio.adc_attenuation_db,
        auto_update_schedule: config.auto_update_schedule.as_str(),
        config_source: "nvs",
    })
}

fn audio_profiles_json(state: &ApiState) -> String {
    let catalog = state
        .audio_profiles
        .lock()
        .expect("audio profile lock poisoned");
    serialize(&*catalog)
}

fn status_json(state: &ApiState) -> String {
    let snapshot = telemetry_snapshot(state);
    serialize(&StatusResponse::from_snapshot(
        &snapshot,
        state.board.as_ref(),
        state.health.as_ref(),
    ))
}

fn board_catalog_json(state: &ApiState) -> String {
    let boards = state
        .board_catalog
        .iter()
        .map(CapabilitiesStatus::from_board)
        .collect();
    serialize(&BoardCatalogResponse {
        selected_board_id: state.board.id.as_str(),
        selected_board: CapabilitiesStatus::from_board(state.board.as_ref()),
        boards,
    })
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
    let rollback = &state.rollback;
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
            input_line: config.audio.input_line,
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
            rollback_available: rollback.is_some(),
            rollback_version: rollback.clone().unwrap_or_default(),
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

impl<'a> StatusResponse<'a> {
    fn from_snapshot(
        snapshot: &'a TelemetrySnapshot,
        board: &'a board::Board,
        health: &'a HealthReport,
    ) -> Self {
        Self {
            firmware_version: snapshot.firmware_version,
            device_name: &snapshot.device_name,
            mode: snapshot.mode,
            config_source: snapshot.config_source,
            web_server: snapshot.web_server,
            configuration_writable: snapshot.configuration_writable,
            auth_required: snapshot.auth_required,
            capabilities: CapabilitiesStatus::from_board(board),
            wifi: WifiStatus {
                hostname: &snapshot.wifi.hostname,
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
                rollback_available: snapshot.ota.rollback_available,
                rollback_version: &snapshot.ota.rollback_version,
            },
            health,
        }
    }
}

/// Serialize an owned response built entirely from primitives and `&str`, which
/// `serde_json` never fails to encode.
fn serialize<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("response is always serializable")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        authorized_secret, board_update_from_form, constant_time_eq, parse_form, serialize,
        BoardCatalogResponse, BoardUpdate, CapabilitiesStatus,
    };
    use crate::board;

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

    #[test]
    fn capabilities_report_a_resolved_board_descriptor() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let board = board::resolve(&catalog, None).expect("default board");
        let json = serialize(&CapabilitiesStatus::from_board(board));
        assert!(json.contains(r#""board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""codec":{"driver":"es8388","i2c_address":16}"#));
        assert!(json.contains(
            r#""pins":{"i2c":{"sda":33,"scl":32},"i2s":{"mclk":0,"bclk":27,"ws":25,"din":35}}"#
        ));
    }

    #[test]
    fn board_catalog_reports_the_active_preset_and_built_ins() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let selected_board = board::resolve(&catalog, None).expect("default board");
        let boards = catalog.iter().map(CapabilitiesStatus::from_board).collect();
        let json = serialize(&BoardCatalogResponse {
            selected_board_id: selected_board.id.as_str(),
            selected_board: CapabilitiesStatus::from_board(selected_board),
            boards,
        });

        assert!(json.contains(r#""selected_board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json
            .contains(r#""selected_board":{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""boards":[{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
    }

    #[test]
    fn board_update_selects_builtin_presets() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let form = parse_form("board_id=ai-thinker-esp32-audio-kit-v2-2-es8388").expect("form");

        let update = board_update_from_form(&form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::BuiltIn(_)));
        assert_eq!(update.board().id, "ai-thinker-esp32-audio-kit-v2-2-es8388");
    }

    fn descriptor_form(board: &board::Board) -> BTreeMap<String, String> {
        let descriptor = serde_json::to_string(board).expect("json");
        parse_form(&format!(
            "descriptor={}",
            descriptor
                .replace('%', "%25")
                .replace('&', "%26")
                .replace('=', "%3D")
                .replace('+', "%2B")
                .replace(' ', "+")
        ))
        .expect("form")
    }

    #[test]
    fn board_update_accepts_custom_descriptors_with_supported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-akv22".to_owned();
        let form = descriptor_form(&custom);

        let update = board_update_from_form(&form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::Custom(_)));
        assert_eq!(update.board().id, "custom-akv22");
    }

    #[test]
    fn board_update_rejects_custom_descriptors_reusing_a_built_in_id() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let custom = board::resolve(&catalog, None).expect("default").clone();
        let form = descriptor_form(&custom);

        let error =
            board_update_from_form(&form, &catalog).expect_err("built-in id must be rejected");

        assert!(error.to_string().contains("built-in"));
    }

    #[test]
    fn board_update_rejects_custom_descriptors_with_unsupported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-unsupported".to_owned();
        custom.codec.driver = "wm8960".to_owned();
        let form = descriptor_form(&custom);

        let error = board_update_from_form(&form, &catalog)
            .expect_err("unsupported codec must be rejected");

        assert!(error.to_string().contains("wm8960"));
    }
}
