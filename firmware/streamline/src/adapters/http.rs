//! Local provisioning and read-only runtime HTTP API.

use std::fmt::Debug;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use embedded_svc::{
    http::{Headers, Method},
    io::{Read, Write},
};
use esp_idf_svc::http::server::{Configuration, EspHttpConnection, EspHttpServer};
use serde::{de::DeserializeOwned, Serialize};

use crate::{
    adapters::{
        codec::CodecControl,
        mdns::MdnsAdvertisement,
        nvs::ConfigStore,
        ota::{self, OtaProgress},
        wifi,
    },
    api::{self, Endpoint, HttpMethod},
    board,
    config::{AudioSettings, AutoUpdateSchedule, RuntimeConfig},
    health::{HealthReport, Severity},
    indicator,
    levels::CLIP_THRESHOLD_ABS,
    metrics::render_prometheus,
    profiles::AudioProfileCatalog,
    recovery,
    runtime::StreamStatus,
    telemetry::{
        AudioTelemetry, DiagnosticsTelemetry, OtaTelemetry, StreamTelemetry, TargetTelemetry,
        TelemetrySnapshot, WifiTelemetry,
    },
    update,
};

const INDEX: &str = include_str!("../../../../console/dist/index.html");
const OPENAPI: &str = include_str!("../../../../docs/openapi.json");
/// A form-urlencoded byte can expand to `%XX`, so a descriptor upload can be
/// three times its raw size on the wire; the rest of the fields fit in 512.
const URL_ENCODED_EXPANSION: usize = 3;
const MAX_REQUEST_BYTES: usize = board::MAX_DESCRIPTOR_BYTES * URL_ENCODED_EXPANSION + 512;
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
    /// A provisioned device that could not join its saved Wi-Fi starts the
    /// setup AP with its validated state and keeps writes behind its key.
    Recovery,
    /// Station on the home network: console behind the admin key, capture
    /// running; the TCP stream runs only while a bridge target is configured.
    Provisioned,
}

impl Mode {
    const fn has_persisted_configuration(self) -> bool {
        matches!(self, Self::Recovery | Self::Provisioned)
    }
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

fn method(endpoint: Endpoint) -> Method {
    match endpoint.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    }
}

/// Thin ESP-IDF binding that refuses to finish unless every declared API
/// operation has exactly one registered handler.
struct ContractServer<'a> {
    inner: EspHttpServer<'a>,
    registered: u32,
}

impl<'a> ContractServer<'a> {
    fn new(inner: EspHttpServer<'a>) -> Self {
        assert!(
            api::ENDPOINTS.len() <= u32::BITS as usize,
            "API endpoint tracker capacity exceeded"
        );
        Self {
            inner,
            registered: 0,
        }
    }

    fn handler<E, F>(&mut self, endpoint: Endpoint, handler: F) -> Result<()>
    where
        F: for<'request> Fn(
                embedded_svc::http::server::Request<&mut EspHttpConnection<'request>>,
            ) -> std::result::Result<(), E>
            + Send
            + 'static,
        E: Debug,
    {
        let index = api::ENDPOINTS
            .iter()
            .position(|declared| *declared == endpoint)
            .expect("registered endpoint is declared");
        let bit = 1_u32 << index;
        if self.registered & bit != 0 {
            bail!("duplicate API handler for {}", endpoint.path);
        }
        self.inner
            .fn_handler(endpoint.path, method(endpoint), handler)?;
        self.registered |= bit;
        Ok(())
    }

    fn finish(self) -> Result<EspHttpServer<'a>> {
        let expected = (1_u32 << api::ENDPOINTS.len()) - 1;
        if self.registered != expected {
            let missing = api::ENDPOINTS
                .iter()
                .enumerate()
                .filter(|(index, _)| self.registered & (1_u32 << index) == 0)
                .map(|(_, endpoint)| endpoint.path)
                .collect::<Vec<_>>()
                .join(", ");
            bail!("missing API handlers: {missing}");
        }
        Ok(self.inner)
    }
}

pub fn start(state: Arc<ApiState>) -> Result<EspHttpServer<'static>> {
    let mut server = EspHttpServer::new(&Configuration {
        stack_size: 8_192,
        ..Default::default()
    })?;
    server.fn_handler("/", Method::Get, move |request| {
        respond(request, 200, "text/html; charset=utf-8", INDEX)
    })?;
    let mut server = ContractServer::new(server);

    let state_for_status = Arc::clone(&state);
    server.handler(api::STATUS, move |request| {
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
    server.handler(api::HEALTH, move |request| {
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
    server.handler(api::METRICS, move |request| {
        respond(
            request,
            200,
            PROMETHEUS_CONTENT_TYPE,
            &metrics_text(&state_for_metrics),
        )
    })?;

    let state_for_config = Arc::clone(&state);
    server.handler(api::SETTINGS, move |request| {
        respond(
            request,
            200,
            "application/json",
            &config_json(&state_for_config),
        )
    })?;

    let state_for_audio_profiles = Arc::clone(&state);
    server.handler(api::AUDIO_PROFILES, move |request| {
        respond(
            request,
            200,
            "application/json",
            &audio_profiles_json(&state_for_audio_profiles),
        )
    })?;

    let state_for_boards = Arc::clone(&state);
    server.handler(api::BOARDS, move |request| {
        respond(
            request,
            200,
            "application/json",
            &board_catalog_json(&state_for_boards),
        )
    })?;

    server.handler(api::OPENAPI, move |request| {
        respond(request, 200, "application/json", OPENAPI)
    })?;

    // Mutating endpoints require the admin key once one is provisioned (see
    // `authorized`); an unconfigured device accepts setup writes so the first
    // key can be set. Wi-Fi and the stream target are separate nouns: each write
    // validates and persists only its own fields, so a malformed target host
    // cannot fail a Wi-Fi save and a Wi-Fi save cannot smuggle in half-typed
    // target edits.
    let state_for_wifi = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_WIFI, move |mut request| {
        if !authorized_for(&request, &state_for_wifi, api::SET_WIFI) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::WifiSettingsRequest = form(&mut request)?;
            let current = state_for_wifi
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            // Commissioning may set the initial stream target in the same
            // write, because the device reboots onto the home network right
            // after and the two cannot be posted separately. Absent target
            // fields are preserved, so a steady-state Wi-Fi change leaves the
            // target alone.
            let next = recovery::replace_wifi(
                current,
                form.ssid,
                form.password,
                form.admin_secret,
                form.target_host.map(|value| value.trim().to_owned()),
                form.target_port,
            );
            save(&state_for_wifi, next)
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })?;

    // The stream target is a stage-3 change, not commissioning: it sets only
    // host and port and leaves Wi-Fi and the admin key untouched. Blank host
    // clears the target ("no bridge yet"). A target change takes effect on the
    // next boot; applying it to the running stream without a reboot is deferred
    // (the stream target is fixed when the network task spawns).
    let state_for_target = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_TARGET, move |mut request| {
        if !authorized_for(&request, &state_for_target, api::SET_TARGET) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::TargetSettingsRequest = form(&mut request)?;
            let current = state_for_target
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let target_host = form.target_host.trim().to_owned();
            let target_port = form.target_port.unwrap_or(current.target_port);
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
    })?;

    let state_for_board = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_BOARD, move |mut request| {
        if !authorized_for(&request, &state_for_board, api::SET_BOARD) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::BoardSettingsRequest = form(&mut request)?;
            let update = board_update_from_form(form, &state_for_board.board_catalog)?;
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
            if state_for_board.mode.has_persisted_configuration() {
                next.validate(selected)
                    .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
            }
            store.save_board_state(
                selected,
                matches!(&update, BoardUpdate::Custom(_)),
                state_for_board
                    .mode
                    .has_persisted_configuration()
                    .then_some(&next),
            )?;
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
    })?;

    // While streaming, audio params are written straight to the running codec
    // and play detection re-baselines to the new input scale — no reboot. In
    // setup-AP mode the codec is not running, so the settings are persisted
    // and take effect when the device boots into streaming.
    let state_for_audio = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO, move |mut request| {
        if !authorized_for(&request, &state_for_audio, api::SET_AUDIO) {
            return unauthorized(request);
        }
        // Ok(true) means the settings were applied live.
        let result = (|| -> Result<bool> {
            let form: api::AudioSettingsRequest = form(&mut request)?;
            let current = state_for_audio
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let audio = AudioSettings {
                input_line: form.input_line,
                input_gain: form.input_gain,
                adc_attenuation_db: form.adc_attenuation_db,
            }
            .validate(state_for_audio.board.as_ref())
            .map_err(|error| anyhow!("invalid audio settings: {error:?}"))?;
            let mut catalog = state_for_audio
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))?
                .clone();
            catalog.active_profile_id = None;
            save_configuration_and_profiles(
                &state_for_audio,
                RuntimeConfig { audio, ..current },
                catalog,
            )?;
            apply_audio_live(&state_for_audio, audio)
        })();
        match result {
            Ok(true) => json_response(request, 200, &api::Ack::ok()),
            Ok(false) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })?;

    // Replacing definitions never activates a profile as a side effect.
    let state_for_profile_catalog = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO_PROFILES, move |mut request| {
        if !authorized_for(
            &request,
            &state_for_profile_catalog,
            api::SET_AUDIO_PROFILES,
        ) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::AudioProfilesSettingsRequest = form(&mut request)?;
            let mut catalog: AudioProfileCatalog = serde_json::from_str(&form.catalog)
                .map_err(|error| anyhow!("invalid audio profile catalog: {error}"))?;
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
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })?;

    // A stable activation contract also serves external source selectors.
    let state_for_active_profile = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO_PROFILE, move |mut request| {
        if !authorized_for(&request, &state_for_active_profile, api::SET_AUDIO_PROFILE) {
            return unauthorized(request);
        }
        let result = (|| -> Result<bool> {
            let form: api::ActiveAudioProfileRequest = form(&mut request)?;
            let mut catalog = state_for_active_profile
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))?
                .clone();
            let audio = catalog
                .activate(Some(&form.profile_id))
                .map_err(|error| anyhow!("invalid active audio profile: {error:?}"))?;
            if let Some(audio) = audio {
                let current = state_for_active_profile
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                save_configuration_and_profiles(
                    &state_for_active_profile,
                    RuntimeConfig { audio, ..current },
                    catalog,
                )?;
                return apply_audio_live(&state_for_active_profile, audio);
            }
            save_audio_profiles(&state_for_active_profile, catalog)?;
            Ok(true)
        })();
        match result {
            Ok(true) => json_response(request, 200, &api::Ack::ok()),
            Ok(false) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })?;

    // The friendly device name only labels the console and browser tab, so it
    // applies immediately — no reboot. Blank clears the name.
    let state_for_name = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_NAME, move |mut request| {
        if !authorized_for(&request, &state_for_name, api::SET_NAME) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::NameSettingsRequest = form(&mut request)?;
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
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })?;

    let state_for_admin_key = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_ADMIN_KEY, move |mut request| {
        if !authorized_for(&request, &state_for_admin_key, api::SET_ADMIN_KEY) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::AdminKeySettingsRequest = form(&mut request)?;
            let mut next = state_for_admin_key
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            next.admin_secret = form.admin_secret;
            save(&state_for_admin_key, next)
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })?;

    let state_for_firmware = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::SET_FIRMWARE, move |mut request| {
        if !authorized_for(&request, &state_for_firmware, api::SET_FIRMWARE) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::FirmwareSettingsRequest = form(&mut request)?;
            let auto_update_schedule = match form.auto_update_schedule {
                api::AutoUpdateScheduleRequest::Disabled => AutoUpdateSchedule::Disabled,
                api::AutoUpdateScheduleRequest::Daily => AutoUpdateSchedule::Daily,
                api::AutoUpdateScheduleRequest::Weekly => AutoUpdateSchedule::Weekly,
            };
            let current = state_for_firmware
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let next = RuntimeConfig {
                auto_update_schedule,
                ..current
            };
            if state_for_firmware.mode.has_persisted_configuration() {
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
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })?;

    // Check GitHub for a newer release without installing it. The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for the
    // outcome (`up-to-date` or `update-available`).
    let state_for_check = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::OTA_CHECK, move |request| {
        if !authorized_for(&request, &state_for_check, api::OTA_CHECK) {
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
    server.handler::<anyhow::Error, _>(api::OTA_UPDATE, move |mut request| {
        if !authorized_for(&request, &state_for_ota, api::OTA_UPDATE) {
            return unauthorized(request);
        }
        let form: api::OtaUpdateRequest = match form(&mut request) {
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
    })?;

    // Roll back to the previous firmware by booting the other slot — instant and
    // offline, no re-download. Flip the boot selection first so an unavailable
    // rollback returns an error instead of a false "rebooting"; the device then
    // reboots into the previous image, which its boot path re-confirms.
    let state_for_rollback = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::OTA_ROLLBACK, move |request| {
        if !authorized_for(&request, &state_for_rollback, api::OTA_ROLLBACK) {
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
    server.handler::<anyhow::Error, _>(api::UNLOCK, move |request| {
        if !authorized_for(&request, &state_for_unlock, api::UNLOCK) {
            return unauthorized(request);
        }
        json_response(request, 200, &api::Ack::ok())
    })?;

    // Plain reboot with settings intact — recovers a wedged stream without a
    // trip to the power plug.
    let state_for_restart = Arc::clone(&state);
    server.handler::<anyhow::Error, _>(api::RESTART, move |request| {
        if !authorized_for(&request, &state_for_restart, api::RESTART) {
            return unauthorized(request);
        }
        reboot_response(request)
    })?;

    server.handler::<anyhow::Error, _>(api::FACTORY_RESET, move |request| {
        if !authorized_for(&request, &state, api::FACTORY_RESET) {
            return unauthorized(request);
        }
        state
            .store
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .clear()?;
        reboot_response(request)
    })?;
    server.finish()
}

fn save(state: &ApiState, config: RuntimeConfig) -> Result<()> {
    config
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    let mut committed = state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .clone();
    recovery::commit_after_persist(&mut committed, config, |next| {
        state
            .store
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .save(next, state.board.as_ref())
    })?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = committed;
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

/// Persist a cross-record profile activation before exposing either its audio
/// values or its active profile id in memory.
fn save_configuration_and_profiles(
    state: &ApiState,
    config: RuntimeConfig,
    catalog: AudioProfileCatalog,
) -> Result<()> {
    config
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    catalog
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save_configuration_and_profiles(&config, &catalog, state.board.as_ref())?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = config;
    *state
        .audio_profiles
        .lock()
        .map_err(|_| anyhow!("audio profile lock poisoned"))? = catalog;
    Ok(())
}

/// Apply already-persisted settings to the codec and reset play detection.
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
    json_response(request, 200, &api::Ack::rebooting())?;
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
        Ok(()) => json_response(request, 202, &api::Ack::started()),
        Err(error) => error_response(request, 409, &error.to_string()),
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

fn authorized_for<C>(
    request: &embedded_svc::http::server::Request<C>,
    state: &ApiState,
    endpoint: Endpoint,
) -> bool
where
    C: embedded_svc::http::server::Connection,
{
    !endpoint.auth || authorized(request, state)
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
    error_response(request, 401, "unauthorized")
}

fn bad_request<C>(
    request: embedded_svc::http::server::Request<C>,
    error: anyhow::Error,
) -> Result<()>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
{
    error_response(request, 400, &error.to_string())
}

fn json_response<C, T>(
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

fn form<C, T>(request: &mut embedded_svc::http::server::Request<C>) -> Result<T>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: DeserializeOwned,
{
    let length = request.content_len().unwrap_or(0) as usize;
    if length > MAX_REQUEST_BYTES {
        bail!("request is too large");
    }
    let mut body = vec![0; length];
    request.read_exact(&mut body)?;
    serde_urlencoded::from_bytes(&body).map_err(|error| anyhow!("invalid form: {error}"))
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
    form: api::BoardSettingsRequest,
    catalog: &[board::Board],
) -> Result<BoardUpdate> {
    let board_id = form.board_id.as_deref().filter(|id| !id.is_empty());
    let descriptor_json = form
        .descriptor
        .as_deref()
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
            if json.len() > board::MAX_DESCRIPTOR_BYTES {
                bail!(
                    "board descriptor is too large: {} bytes, max {}",
                    json.len(),
                    board::MAX_DESCRIPTOR_BYTES
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
            Ok(BoardUpdate::Custom(board))
        }
        (None, None) => bail!("board_id or descriptor is required"),
    }
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&api::ConfigResponse {
        device_name: &config.device_name,
        ssid: &config.ssid,
        target_host: &config.target_host,
        target_port: config.target_port,
        input_line: config.audio.input_line,
        input_gain: config.audio.input_gain,
        adc_attenuation_db: config.audio.adc_attenuation_db,
        auto_update_schedule: config.auto_update_schedule.into(),
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
    serialize(&api::StatusResponse::from_snapshot(
        &snapshot,
        state.board.as_ref(),
        state.health.as_ref(),
    ))
}

fn board_catalog_json(state: &ApiState) -> String {
    let boards = state
        .board_catalog
        .iter()
        .map(api::CapabilitiesStatus::from_board)
        .collect();
    serialize(&api::BoardCatalogResponse {
        selected_board_id: state.board.id.as_str(),
        selected_board: api::CapabilitiesStatus::from_board(state.board.as_ref()),
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
        Mode::Setup | Mode::Recovery => ("setup", "ap"),
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

impl<'a> api::StatusResponse<'a> {
    fn from_snapshot(
        snapshot: &'a TelemetrySnapshot,
        board: &'a board::Board,
        health: &'a HealthReport,
    ) -> Self {
        let indicator_state = indicator::select(
            snapshot.mode == "setup",
            health.status == Severity::Blocking,
            snapshot.audio.playing,
        );
        Self {
            firmware_version: snapshot.firmware_version,
            device_name: &snapshot.device_name,
            mode: snapshot.mode,
            config_source: snapshot.config_source,
            web_server: snapshot.web_server,
            configuration_writable: snapshot.configuration_writable,
            auth_required: snapshot.auth_required,
            capabilities: api::CapabilitiesStatus::from_board(board),
            wifi: api::WifiStatus {
                hostname: &snapshot.wifi.hostname,
                ssid: &snapshot.wifi.ssid,
                status: snapshot.wifi.status,
                sta_ip: &snapshot.wifi.sta_ip,
                ap_ip: &snapshot.wifi.ap_ip,
                rssi: snapshot.wifi.rssi_dbm,
            },
            target: api::TargetStatus {
                target_host: &snapshot.target.host,
                target_port: snapshot.target.port,
                transport: snapshot.target.transport,
            },
            audio: api::AudioStatus {
                input_line: snapshot.audio.input_line,
                input_gain: snapshot.audio.input_gain,
                adc_attenuation_db: snapshot.audio.adc_attenuation_db,
                sample_rate: snapshot.audio.sample_rate_hz,
                channels: snapshot.audio.channels,
                bits_per_sample: snapshot.audio.bits_per_sample,
            },
            metrics: api::MetricsStatus {
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
            diagnostics: api::DiagnosticsStatus {
                reset_reason: snapshot.diagnostics.reset_reason,
                last_fallback: &snapshot.diagnostics.last_fallback,
                last_ota: &snapshot.diagnostics.last_ota,
            },
            ota: api::OtaStatus {
                phase: snapshot.ota.phase,
                bytes_written: snapshot.ota.bytes_written,
                bytes_total: snapshot.ota.bytes_total,
                latest_version: &snapshot.ota.latest_version,
                message: &snapshot.ota.message,
                busy: snapshot.ota.busy,
                rollback_available: snapshot.ota.rollback_available,
                rollback_version: &snapshot.ota.rollback_version,
            },
            indicator: api::IndicatorStatus {
                available: board.status_led.is_some(),
                state: indicator_state.as_str(),
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
    use super::{
        authorized_secret, board_update_from_form, constant_time_eq, serialize, BoardUpdate,
    };
    use crate::{api, board};

    #[test]
    fn decodes_browser_urlencoded_forms() {
        let form: api::WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Studio+WiFi&target_host=bridge%2Elocal")
                .expect("valid form");
        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host.as_deref(), Some("bridge.local"));
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
        let json = serialize(&api::CapabilitiesStatus::from_board(board));
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
        let boards = catalog
            .iter()
            .map(api::CapabilitiesStatus::from_board)
            .collect();
        let json = serialize(&api::BoardCatalogResponse {
            selected_board_id: selected_board.id.as_str(),
            selected_board: api::CapabilitiesStatus::from_board(selected_board),
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
        let form = api::BoardSettingsRequest {
            board_id: Some("ai-thinker-esp32-audio-kit-v2-2-es8388".to_owned()),
            descriptor: None,
        };

        let update = board_update_from_form(form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::BuiltIn(_)));
        assert_eq!(update.board().id, "ai-thinker-esp32-audio-kit-v2-2-es8388");
    }

    fn descriptor_form(board: &board::Board) -> api::BoardSettingsRequest {
        api::BoardSettingsRequest {
            board_id: None,
            descriptor: Some(serde_json::to_string(board).expect("json")),
        }
    }

    #[test]
    fn board_update_accepts_custom_descriptors_with_supported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-akv22".to_owned();
        let form = descriptor_form(&custom);

        let update = board_update_from_form(form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::Custom(_)));
        assert_eq!(update.board().id, "custom-akv22");
    }

    #[test]
    fn board_update_rejects_custom_descriptors_reusing_a_built_in_id() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let custom = board::resolve(&catalog, None).expect("default").clone();
        let form = descriptor_form(&custom);

        let error =
            board_update_from_form(form, &catalog).expect_err("built-in id must be rejected");

        assert!(error.to_string().contains("built-in"));
    }

    #[test]
    fn board_update_rejects_custom_descriptors_with_unsupported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-unsupported".to_owned();
        custom.codec.driver = "wm8960".to_owned();
        let form = descriptor_form(&custom);

        let error =
            board_update_from_form(form, &catalog).expect_err("unsupported codec must be rejected");

        assert!(error.to_string().contains("wm8960"));
    }
}
