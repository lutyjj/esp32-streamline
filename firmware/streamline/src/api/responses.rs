//! Response DTOs the device serializes at its read and acknowledgement
//! endpoints.

use serde::Serialize;
#[cfg(feature = "api-spec")]
use serde_json::json;

use crate::{board::Board, health::HealthReport};

use super::requests::AutoUpdateScheduleRequest;

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
#[cfg_attr(feature = "api-spec", schema(example = json!(crate::api::examples::config())))]
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
    /// The effective role of every board LED, in descriptor order.
    pub led_roles: Vec<LedRoleStatus<'a>>,
    /// The effective action of every board button, in descriptor order.
    pub button_actions: Vec<ButtonActionStatus<'a>>,
    pub auto_update_schedule: AutoUpdateScheduleRequest,
    pub config_source: &'a str,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct LedRoleStatus<'a> {
    pub id: &'a str,
    pub role: crate::led::LedRole,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct ButtonActionStatus<'a> {
    pub id: &'a str,
    pub action: crate::button::ButtonAction,
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
#[cfg_attr(feature = "api-spec", schema(example = json!(crate::api::examples::status())))]
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
    pub stream: StreamControlStatus,
    pub metrics: MetricsStatus,
    pub diagnostics: DiagnosticsStatus<'a>,
    pub system: SystemStatus,
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
    pub leds: Vec<LedCapabilityStatus<'a>>,
    pub buttons: Vec<ButtonCapabilityStatus<'a>>,
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
pub struct LedCapabilityStatus<'a> {
    pub id: &'a str,
    pub label: &'a str,
    pub gpio: u8,
    pub active_low: bool,
    pub default_role: crate::led::LedRole,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct ButtonCapabilityStatus<'a> {
    pub id: &'a str,
    pub label: &'a str,
    pub gpio: u8,
    pub active_low: bool,
    pub default_action: crate::button::ButtonAction,
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
            leds: board
                .leds
                .iter()
                .map(|led| LedCapabilityStatus {
                    id: led.id.as_str(),
                    label: led.label.as_str(),
                    gpio: led.gpio,
                    active_low: led.active_low,
                    default_role: led.default_role,
                })
                .collect(),
            buttons: board
                .buttons
                .iter()
                .map(|button| ButtonCapabilityStatus {
                    id: button.id.as_str(),
                    label: button.label.as_str(),
                    gpio: button.gpio,
                    active_low: button.active_low,
                    default_action: button.default_action,
                })
                .collect(),
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

/// Device resource headroom: RAM, NVS storage, uptime, and task count.
#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct SystemStatus {
    pub uptime_seconds: u64,
    pub task_count: u32,
    pub heap: HeapStatus,
    pub nvs: NvsStatus,
}

/// Internal RAM heap, in bytes.
#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct HeapStatus {
    pub free_bytes: u32,
    pub total_bytes: u32,
    pub minimum_free_bytes: u32,
    pub largest_free_block_bytes: u32,
}

/// NVS configuration partition usage, in 32-byte entries.
#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct NvsStatus {
    pub used_entries: u32,
    pub available_entries: u32,
    pub total_entries: u32,
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
    pub stale_drops_total: u64,
    pub network_errors_total: u64,
    pub tls_handshake_failures_total: u64,
    pub reconnects_total: u64,
    pub send_stalls_total: u64,
    pub longest_send_stall_ms: u64,
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
    /// Whether this firmware rejects an over-the-air image that is not signed by
    /// the vendor key it trusts. Always true on a signed release build; false on
    /// an unsigned self-build.
    pub signed_updates: bool,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct AnalogPassthroughStatus<'a> {
    pub enabled: bool,
    pub active: bool,
    pub fault: Option<&'a str>,
}

/// Runtime streaming control, flipped by `POST /api/stream` and the
/// `toggle_stream` button action. Not persisted: a reboot resumes streaming.
#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct StreamControlStatus {
    pub enabled: bool,
}

#[derive(Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct IndicatorStatus {
    pub available: bool,
    pub state: &'static str,
}

/// The device's captured log, as `GET /api/logs` returns it.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct LogsResponse {
    pub current: BootLog,
    /// The boot before this one. `null` after a power cycle, which clears the
    /// memory the lines were held in, and on a device that has not restarted
    /// since it started capturing.
    pub previous: Option<BootLog>,
}

/// The lines one boot produced, as much of them as the buffer holds.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct BootLog {
    /// Oldest first.
    pub lines: Vec<LoggedLine>,
    /// Lines this boot produced that the buffer has already discarded. A
    /// non-zero count means `lines` starts later than the boot did.
    pub dropped: u64,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct LoggedLine {
    /// Position within the boot, counted from zero, so a poller can tell new
    /// lines from lines it already read.
    pub sequence: u64,
    pub text: String,
}

impl LogsResponse {
    /// Copy both buffers into an owned response.
    ///
    /// Owned rather than borrowed on purpose: the caller holds the capture
    /// lock, and every logging task waits behind it until this returns.
    pub fn from_buffers<const CURRENT: usize, const PREVIOUS: usize>(
        current: &crate::logs::LogRing<CURRENT>,
        previous: Option<&crate::logs::LogRing<PREVIOUS>>,
    ) -> Self {
        Self {
            current: BootLog::from_buffer(current),
            previous: previous.map(BootLog::from_buffer),
        }
    }
}

impl BootLog {
    fn from_buffer<const N: usize>(buffer: &crate::logs::LogRing<N>) -> Self {
        Self {
            lines: buffer
                .lines()
                .map(|line| LoggedLine {
                    sequence: line.sequence,
                    text: line.text().into_owned(),
                })
                .collect(),
            dropped: buffer.dropped(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(json.contains(
            r#""leds":[{"id":"status","label":"Status light (D4)","gpio":22,"active_low":true,"default_role":"status"}]"#
        ));
        assert!(json.contains(
            r#""buttons":[{"id":"key1","label":"Key 1","gpio":36,"active_low":true,"default_action":"toggle_stream"}"#
        ));
        assert!(json.contains(
            r#"{"id":"key6","label":"Key 6","gpio":5,"active_low":true,"default_action":"restart"}]"#
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
