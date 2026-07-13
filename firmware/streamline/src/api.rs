//! Device HTTP contract.
//!
//! Route metadata and wire DTOs live here so the firmware adapter, generated
//! OpenAPI document, and generated console types all derive from Rust types
//! that the device actually serializes and deserializes.

use serde::{Deserialize, Serialize};

#[cfg(feature = "api-spec")]
use crate::profiles::AudioProfileCatalog;
use crate::{board::Board, health::HealthReport};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Endpoint {
    pub method: HttpMethod,
    pub path: &'static str,
    pub auth: bool,
}

macro_rules! endpoint {
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, public, $($contract:tt)*) => {
        pub const $name: Endpoint = Endpoint {
            method: HttpMethod::$method,
            path: $path,
            auth: false,
        };
        #[cfg(feature = "api-spec")]
        #[allow(dead_code)]
        #[utoipa::path($verb, path = $path, $($contract)*)]
        fn $operation() {}
    };
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, authenticated, $($contract:tt)*) => {
        pub const $name: Endpoint = Endpoint {
            method: HttpMethod::$method,
            path: $path,
            auth: true,
        };
        #[cfg(feature = "api-spec")]
        #[allow(dead_code)]
        #[utoipa::path(
            $verb,
            path = $path,
            security(("bearer_auth" = [])),
            $($contract)*
        )]
        fn $operation() {}
    };
}

endpoint!(
    STATUS,
    get_status,
    Get,
    get,
    "/api/status",
    public,
    summary = "Read device status",
    responses((status = 200, body = StatusResponse))
);
endpoint!(
    HEALTH,
    get_health,
    Get,
    get,
    "/api/health",
    public,
    summary = "Read startup health",
    responses(
        (status = 200, body = HealthReport),
        (status = 503, body = HealthReport)
    )
);
endpoint!(
    METRICS,
    get_metrics,
    Get,
    get,
    "/api/metrics",
    public,
    summary = "Read Prometheus metrics",
    responses((status = 200, content_type = "text/plain", body = String))
);
endpoint!(
    SETTINGS,
    get_settings,
    Get,
    get,
    "/api/settings",
    public,
    summary = "Read device settings",
    responses((status = 200, body = ConfigResponse))
);
endpoint!(
    AUDIO_PROFILES,
    get_audio_profiles,
    Get,
    get,
    "/api/audio-profiles",
    public,
    summary = "Read saved audio profiles",
    responses((status = 200, body = AudioProfileCatalog))
);
endpoint!(
    BOARDS,
    get_boards,
    Get,
    get,
    "/api/boards",
    public,
    summary = "List board capabilities",
    responses((status = 200, body = BoardCatalogResponse))
);
endpoint!(
    OPENAPI,
    get_openapi,
    Get,
    get,
    "/api/openapi.json",
    public,
    summary = "Read the OpenAPI contract",
    responses((status = 200, body = Object))
);
endpoint!(
    SET_WIFI,
    set_wifi,
    Post,
    post,
    "/api/settings/wifi",
    authenticated,
    summary = "Set Wi-Fi settings",
    request_body(
        content = WifiSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_TARGET,
    set_target,
    Post,
    post,
    "/api/settings/target",
    authenticated,
    summary = "Set stream target",
    request_body(
        content = TargetSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_TRANSPORT,
    set_transport_mode,
    Post,
    post,
    "/api/settings/transport",
    authenticated,
    summary = "Set the PCM transport mode",
    request_body(
        content = TransportSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_STAGE,
    stage_transport_key,
    Post,
    post,
    "/api/transport/keys/stage",
    authenticated,
    summary = "Generate and stage a per-device PCM transport key",
    responses(
        (status = 200, body = TransportKeyResponse),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_VERIFY,
    verify_transport_key,
    Post,
    post,
    "/api/transport/keys/verify",
    authenticated,
    summary = "Verify the pending PCM transport key against the bridge",
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 503, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_ACTIVATE,
    activate_transport_key,
    Post,
    post,
    "/api/transport/keys/activate",
    authenticated,
    summary = "Activate the verified PCM transport key",
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_DISCARD,
    discard_transport_key,
    Post,
    post,
    "/api/transport/keys/discard",
    authenticated,
    summary = "Discard the pending PCM transport key",
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_ROLLBACK,
    rollback_transport_key,
    Post,
    post,
    "/api/transport/keys/rollback",
    authenticated,
    summary = "Restore the previous PCM transport key",
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_KEY_RETIRE,
    retire_transport_key,
    Post,
    post,
    "/api/transport/keys/retire",
    authenticated,
    summary = "Retire the PCM transport rollback key",
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    TRANSPORT_RECOVER,
    recover_transport,
    Post,
    post,
    "/api/transport/recover",
    authenticated,
    summary = "Return to cleartext and replace an unusable pending key",
    responses(
        (status = 200, body = TransportKeyResponse),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_BOARD,
    set_board,
    Post,
    post,
    "/api/settings/board",
    authenticated,
    summary = "Select a board descriptor",
    request_body(
        content = BoardSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_AUDIO,
    set_audio,
    Post,
    post,
    "/api/settings/audio",
    authenticated,
    summary = "Set audio levels",
    request_body(
        content = AudioSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_ANALOG_PASSTHROUGH,
    set_analog_passthrough,
    Post,
    post,
    "/api/settings/analog-passthrough",
    authenticated,
    summary = "Set the local analog output",
    request_body(
        content = AnalogPassthroughSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 503, body = ErrorResponse)
    )
);
endpoint!(
    SET_AUDIO_PROFILES,
    set_audio_profiles,
    Post,
    post,
    "/api/settings/audio-profiles",
    authenticated,
    summary = "Replace saved audio profiles",
    request_body(
        content = AudioProfilesSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_AUDIO_PROFILE,
    set_audio_profile,
    Post,
    post,
    "/api/settings/audio-profile",
    authenticated,
    summary = "Activate an audio profile",
    request_body(
        content = ActiveAudioProfileRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_NAME,
    set_name,
    Post,
    post,
    "/api/settings/name",
    authenticated,
    summary = "Set device name",
    request_body(
        content = NameSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_ADMIN_KEY,
    set_admin_key,
    Post,
    post,
    "/api/settings/admin-key",
    authenticated,
    summary = "Replace the admin key",
    request_body(
        content = AdminKeySettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    SET_FIRMWARE,
    set_firmware,
    Post,
    post,
    "/api/settings/firmware",
    authenticated,
    summary = "Set the automatic update schedule",
    request_body(
        content = FirmwareSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    OTA_CHECK,
    ota_check,
    Post,
    post,
    "/api/ota/check",
    authenticated,
    summary = "Check for a firmware update",
    responses(
        (status = 202, body = Ack),
        (status = 409, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    OTA_UPDATE,
    ota_update,
    Post,
    post,
    "/api/ota/update",
    authenticated,
    summary = "Install firmware",
    request_body(
        content = OtaUpdateRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 202, body = Ack),
        (status = 400, body = ErrorResponse),
        (status = 409, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    OTA_ROLLBACK,
    ota_rollback,
    Post,
    post,
    "/api/ota/rollback",
    authenticated,
    summary = "Roll back firmware",
    responses(
        (status = 200, body = Ack),
        (status = 409, body = ErrorResponse),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    UNLOCK,
    unlock,
    Post,
    post,
    "/api/unlock",
    authenticated,
    summary = "Verify the admin key",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    RESTART,
    restart,
    Post,
    post,
    "/api/restart",
    authenticated,
    summary = "Restart the device",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    FACTORY_RESET,
    factory_reset,
    Post,
    post,
    "/api/factory-reset",
    authenticated,
    summary = "Factory-reset the device",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse)
    )
);

pub const ENDPOINTS: &[Endpoint] = &[
    STATUS,
    HEALTH,
    METRICS,
    SETTINGS,
    AUDIO_PROFILES,
    BOARDS,
    OPENAPI,
    SET_WIFI,
    SET_TARGET,
    SET_TRANSPORT,
    TRANSPORT_KEY_STAGE,
    TRANSPORT_KEY_VERIFY,
    TRANSPORT_KEY_ACTIVATE,
    TRANSPORT_KEY_DISCARD,
    TRANSPORT_KEY_ROLLBACK,
    TRANSPORT_KEY_RETIRE,
    TRANSPORT_RECOVER,
    SET_BOARD,
    SET_AUDIO,
    SET_ANALOG_PASSTHROUGH,
    SET_AUDIO_PROFILES,
    SET_AUDIO_PROFILE,
    SET_NAME,
    SET_ADMIN_KEY,
    SET_FIRMWARE,
    OTA_CHECK,
    OTA_UPDATE,
    OTA_ROLLBACK,
    UNLOCK,
    RESTART,
    FACTORY_RESET,
];

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct WifiSettingsRequest {
    /// Wi-Fi network name. Empty names are rejected.
    #[cfg_attr(feature = "api-spec", schema(min_length = 1))]
    pub ssid: String,
    /// Wi-Fi password. Empty preserves the stored password.
    #[serde(default)]
    pub password: String,
    /// Optional bridge host set during first commissioning.
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/]*$"))]
    pub target_host: Option<String>,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1))]
    pub target_port: Option<u16>,
    /// Admin key. Empty preserves the stored key.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(min_length = 8))]
    pub admin_secret: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct TargetSettingsRequest {
    /// Hostname or IP without a scheme, port, or path. Empty clears the target.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/]*$"))]
    pub target_host: String,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1))]
    pub target_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct TransportSettingsRequest {
    pub contract_version: u8,
    pub mode: crate::transport::TransportMode,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Select exactly one built-in id or a JSON-encoded custom descriptor.
pub struct BoardSettingsRequest {
    pub board_id: Option<String>,
    /// JSON-encoded descriptor, capped at 3072 UTF-8 bytes by the device.
    #[cfg_attr(feature = "api-spec", schema(max_length = 3072))]
    pub descriptor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Audio values are validated against `/api/status.capabilities`.
pub struct AudioSettingsRequest {
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AnalogPassthroughSettingsRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioProfilesSettingsRequest {
    /// JSON-encoded `AudioProfileCatalog`.
    pub catalog: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct ActiveAudioProfileRequest {
    /// Empty returns to custom audio settings.
    #[serde(default)]
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct NameSettingsRequest {
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(max_length = 32))]
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AdminKeySettingsRequest {
    #[cfg_attr(feature = "api-spec", schema(min_length = 8))]
    pub admin_secret: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct FirmwareSettingsRequest {
    pub auto_update_schedule: AutoUpdateScheduleRequest,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum AutoUpdateScheduleRequest {
    Disabled,
    Daily,
    Weekly,
}

impl From<crate::config::AutoUpdateSchedule> for AutoUpdateScheduleRequest {
    fn from(value: crate::config::AutoUpdateSchedule) -> Self {
        match value {
            crate::config::AutoUpdateSchedule::Disabled => Self::Disabled,
            crate::config::AutoUpdateSchedule::Daily => Self::Daily,
            crate::config::AutoUpdateSchedule::Weekly => Self::Weekly,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Empty installs the latest release. A custom install requires both fields.
pub struct OtaUpdateRequest {
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^https?://"))]
    pub url: Option<String>,
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[0-9A-Fa-f]{64}$"))]
    pub sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct Ack {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebooting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<bool>,
}

impl Ack {
    pub const fn ok() -> Self {
        Self {
            ok: Some(true),
            rebooting: None,
            started: None,
        }
    }

    pub const fn rebooting() -> Self {
        Self {
            ok: Some(true),
            rebooting: Some(true),
            started: None,
        }
    }

    pub const fn started() -> Self {
        Self {
            ok: Some(true),
            rebooting: None,
            started: Some(true),
        }
    }
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct ErrorResponse<'a> {
    pub error: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct ConfigResponse<'a> {
    pub device_name: &'a str,
    pub ssid: &'a str,
    pub target_host: &'a str,
    pub target_port: u16,
    pub transport: TransportStatus<'a>,
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
    pub analog_passthrough_enabled: bool,
    pub auto_update_schedule: AutoUpdateScheduleRequest,
    pub config_source: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct TransportStatus<'a> {
    pub contract_version: u8,
    pub mode: crate::transport::TransportMode,
    pub active_key_id: Option<&'a str>,
    pub pending_key_id: Option<&'a str>,
    pub pending_verified: bool,
    pub rollback_key_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct TransportKeyResponse {
    pub contract_version: u8,
    pub key_id: String,
    /// Shown once. The device never returns this PSK through a read endpoint.
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[0-9a-f]{64}$"))]
    pub psk: String,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct BoardCatalogResponse<'a> {
    pub selected_board_id: &'a str,
    pub selected_board: CapabilitiesStatus<'a>,
    pub boards: Vec<CapabilitiesStatus<'a>>,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct StatusResponse<'a> {
    pub firmware_version: &'a str,
    pub device_name: &'a str,
    #[cfg_attr(feature = "api-spec", schema(inline))]
    pub mode: &'a str,
    pub config_source: &'a str,
    pub web_server: bool,
    pub configuration_writable: bool,
    pub auth_required: bool,
    pub capabilities: CapabilitiesStatus<'a>,
    pub wifi: WifiStatus<'a>,
    pub target: TargetStatus<'a>,
    pub audio: AudioStatus,
    pub analog_passthrough: AnalogPassthroughStatus<'a>,
    pub metrics: MetricsStatus,
    pub diagnostics: DiagnosticsStatus<'a>,
    pub ota: OtaStatus<'a>,
    pub indicator: IndicatorStatus,
    pub health: &'a HealthReport,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct CapabilitiesStatus<'a> {
    pub board_id: &'a str,
    pub board: &'a str,
    pub codec: CodecStatus<'a>,
    pub pins: PinMapStatus,
    pub status_led: Option<StatusLedStatus>,
    pub analog_passthrough: Option<AnalogPassthroughCapabilityStatus<'a>>,
    pub input_lines: Vec<InputLineStatus<'a>>,
    pub input_gain_max: u8,
    pub adc_atten_max_db: u8,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct CodecStatus<'a> {
    pub driver: &'a str,
    pub i2c_address: u8,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct PinMapStatus {
    pub i2c: I2cPinsStatus,
    pub i2s: I2sPinsStatus,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct I2cPinsStatus {
    pub sda: u8,
    pub scl: u8,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct I2sPinsStatus {
    pub mclk: u8,
    pub bclk: u8,
    pub ws: u8,
    pub din: u8,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct StatusLedStatus {
    pub gpio: u8,
    pub active_low: bool,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct InputLineStatus<'a> {
    pub line: u8,
    pub label: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct AnalogPassthroughCapabilityStatus<'a> {
    pub output_line: u8,
    pub label: &'a str,
}

impl<'a> CapabilitiesStatus<'a> {
    pub fn from_board(board: &'a Board) -> Self {
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
            status_led: board.status_led.map(|led| StatusLedStatus {
                gpio: led.gpio,
                active_low: led.active_low,
            }),
            analog_passthrough: board.analog_passthrough.as_ref().map(|capability| {
                AnalogPassthroughCapabilityStatus {
                    output_line: capability.output_line,
                    label: capability.label.as_str(),
                }
            }),
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

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct DiagnosticsStatus<'a> {
    pub reset_reason: &'a str,
    pub last_fallback: &'a str,
    pub last_ota: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct WifiStatus<'a> {
    pub hostname: &'a str,
    pub ssid: &'a str,
    pub status: &'a str,
    pub sta_ip: &'a str,
    pub ap_ip: &'a str,
    pub rssi: i32,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct TargetStatus<'a> {
    pub target_host: &'a str,
    pub target_port: u16,
    pub transport: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct AudioStatus {
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
    pub sample_rate: u32,
    pub channels: u8,
    pub bits_per_sample: u8,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct MetricsStatus {
    pub sequence: u32,
    pub packets: u64,
    pub bytes: u64,
    pub read_errors: u64,
    pub short_reads: u64,
    pub queue_depth: u32,
    pub queue_drops_total: u64,
    pub network_errors_total: u64,
    pub tls_handshake_failures_total: u64,
    pub reconnects_total: u64,
    pub clip_threshold_abs: u16,
    pub peak_abs_left: u32,
    pub peak_abs_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub noise_floor: u32,
    pub clipped_samples_total: u64,
    pub playing: bool,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct OtaStatus<'a> {
    pub phase: &'a str,
    pub bytes_written: u32,
    pub bytes_total: u32,
    pub latest_version: &'a str,
    pub message: &'a str,
    pub busy: bool,
    pub rollback_available: bool,
    pub rollback_version: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct AnalogPassthroughStatus<'a> {
    pub enabled: bool,
    pub active: bool,
    pub fault: Option<&'a str>,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct IndicatorStatus {
    pub available: bool,
    pub state: &'static str,
}

#[cfg(feature = "api-spec")]
mod spec {
    use super::*;
    use utoipa::OpenApi;

    #[derive(OpenApi)]
    #[openapi(
        info(title = "StreamLine device API", version = "2.0.0"),
        paths(get_status, get_health, get_metrics, get_settings, get_audio_profiles, get_boards, get_openapi, set_wifi, set_target, set_transport_mode, stage_transport_key, verify_transport_key, activate_transport_key, discard_transport_key, rollback_transport_key, retire_transport_key, recover_transport, set_board, set_audio, set_analog_passthrough, set_audio_profiles, set_audio_profile, set_name, set_admin_key, set_firmware, ota_check, ota_update, ota_rollback, unlock, restart, factory_reset),
        components(schemas(crate::board::Board, crate::profiles::AudioProfileCatalog)),
        modifiers(&Security)
    )]
    struct ApiDoc;

    struct Security;

    impl utoipa::Modify for Security {
        fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
            use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
            openapi
                .components
                .as_mut()
                .expect("components")
                .add_security_scheme(
                    "bearer_auth",
                    SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
                );
        }
    }

    pub fn openapi() -> utoipa::openapi::OpenApi {
        let document = ApiDoc::openapi();
        let json = serde_json::to_value(&document).expect("serializable OpenAPI");
        let paths = json["paths"].as_object().expect("OpenAPI paths");
        let operation_count: usize = paths
            .values()
            .map(|item| item.as_object().expect("path item").len())
            .sum();
        assert_eq!(operation_count, ENDPOINTS.len(), "OpenAPI operation count");
        for endpoint in ENDPOINTS {
            let verb = match endpoint.method {
                HttpMethod::Get => "get",
                HttpMethod::Post => "post",
            };
            let operation = &json["paths"][endpoint.path][verb];
            assert!(operation.is_object(), "missing {verb} {}", endpoint.path);
            assert_eq!(
                operation.get("security").is_some(),
                endpoint.auth,
                "authentication mismatch for {verb} {}",
                endpoint.path
            );
        }
        let schemas = &json["components"]["schemas"];
        assert_eq!(
            schemas["WifiSettingsRequest"]["properties"]["admin_secret"]["minLength"],
            crate::config::MIN_ADMIN_SECRET_LEN
        );
        assert_eq!(
            schemas["AdminKeySettingsRequest"]["properties"]["admin_secret"]["minLength"],
            crate::config::MIN_ADMIN_SECRET_LEN
        );
        assert_eq!(
            schemas["NameSettingsRequest"]["properties"]["name"]["maxLength"],
            crate::config::MAX_DEVICE_NAME_CHARS
        );
        assert_eq!(
            schemas["BoardSettingsRequest"]["properties"]["descriptor"]["maxLength"],
            crate::board::MAX_DESCRIPTOR_BYTES
        );
        // Profile import limits ride the schema so clients validate against the
        // contract. These bind the emitted keywords to the model's constants.
        let profile = &schemas["AudioProfile"]["properties"];
        assert_eq!(
            profile["id"]["pattern"],
            crate::profiles::AUDIO_PROFILE_ID_PATTERN
        );
        assert_eq!(
            profile["id"]["maxLength"],
            crate::profiles::MAX_AUDIO_PROFILE_ID_CHARS
        );
        assert_eq!(
            profile["name"]["maxLength"],
            crate::profiles::MAX_AUDIO_PROFILE_NAME_CHARS
        );
        assert_eq!(
            schemas["AudioProfileCatalog"]["properties"]["profiles"]["maxItems"],
            crate::profiles::MAX_AUDIO_PROFILES
        );
        document
    }
}

#[cfg(feature = "api-spec")]
pub fn openapi_json() -> String {
    spec::openapi().to_json().expect("serializable OpenAPI")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_method_and_path_pairs_are_unique() {
        for (index, endpoint) in ENDPOINTS.iter().enumerate() {
            assert!(endpoint.path.starts_with("/api/"));
            assert!(!ENDPOINTS[index + 1..]
                .iter()
                .any(|other| other.method == endpoint.method && other.path == endpoint.path));
        }
    }

    #[test]
    fn request_dtos_reject_fields_outside_the_contract() {
        let result = serde_urlencoded::from_str::<AudioSettingsRequest>(
            "input_line=2&input_gain=0&adc_attenuation_db=0&unexpected=true",
        );
        assert!(result.is_err());
    }

    #[test]
    fn request_dtos_decode_browser_urlencoded_forms() {
        let form: WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Studio+WiFi&target_host=bridge%2Elocal")
                .expect("valid form");
        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host.as_deref(), Some("bridge.local"));
    }

    #[test]
    fn capabilities_report_a_resolved_board_descriptor() {
        let catalog = crate::board::builtin_catalog().expect("valid catalog");
        let board = crate::board::resolve(&catalog, None).expect("default board");
        let json = serde_json::to_string(&CapabilitiesStatus::from_board(board))
            .expect("serializable capabilities");
        assert!(json.contains(r#""board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""codec":{"driver":"es8388","i2c_address":16}"#));
        assert!(json.contains(
            r#""pins":{"i2c":{"sda":33,"scl":32},"i2s":{"mclk":0,"bclk":27,"ws":25,"din":35}}"#
        ));
        assert!(json.contains(r#""analog_passthrough":{"output_line":2,"label":"3.5 mm output"}"#));
    }

    #[test]
    fn board_catalog_reports_the_active_preset_and_built_ins() {
        let catalog = crate::board::builtin_catalog().expect("valid catalog");
        let selected_board = crate::board::resolve(&catalog, None).expect("default board");
        let boards = catalog.iter().map(CapabilitiesStatus::from_board).collect();
        let json = serde_json::to_string(&BoardCatalogResponse {
            selected_board_id: selected_board.id.as_str(),
            selected_board: CapabilitiesStatus::from_board(selected_board),
            boards,
        })
        .expect("serializable board catalog");

        assert!(json.contains(r#""selected_board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json
            .contains(r#""selected_board":{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""boards":[{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
    }

    #[test]
    fn acknowledgement_variants_serialize_through_one_dto() {
        assert_eq!(
            serde_json::to_string(&Ack::rebooting()).expect("serializable"),
            r#"{"ok":true,"rebooting":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Ack::started()).expect("serializable"),
            r#"{"ok":true,"started":true}"#
        );
    }
}
