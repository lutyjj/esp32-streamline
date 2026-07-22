//! The canonical example device the OpenAPI document carries.
//!
//! Clients derive their fixtures from these schema examples instead of
//! hand-writing coherent device state (console mocks, the Home Assistant
//! integration's test payloads). Each example is built as the real DTO and
//! serialized by the real serializer, so it cannot drift from the schema:
//! a field change breaks compilation here before any consumer sees it.
//! Values use documentation addresses only; capabilities come from the
//! built-in default board and health from the real assessor.

use serde_json::Value;

use crate::health::{BootFacts, HealthReport};

use super::requests::AutoUpdateScheduleRequest;
use super::responses::*;

const FIRMWARE_VERSION: &str = "0.4.0";
const SSID: &str = "home";
const HOSTNAME: &str = "streamline-0000.local";
const DEVICE_IP: &str = "192.0.2.10";
const BRIDGE_HOST: &str = "192.0.2.20";
const BRIDGE_PORT: u16 = 39000;

/// A healthy, provisioned, streaming device, as `GET /api/status` reports it.
pub fn status() -> Value {
    let catalog = crate::board::builtin_catalog().expect("valid built-in catalog");
    let board = crate::board::resolve(&catalog, None).expect("default board");
    let health = HealthReport::assess(&BootFacts {
        audio: Some(Ok(())),
        bridge_configured: true,
        board_name: board.name.clone(),
    });
    let status = StatusResponse {
        firmware_version: FIRMWARE_VERSION,
        device_name: "",
        mode: "provisioned",
        config_source: "nvs",
        web_server: true,
        configuration_writable: true,
        auth_required: true,
        capabilities: CapabilitiesStatus::from_board(board),
        wifi: WifiStatus {
            hostname: HOSTNAME,
            ssid: SSID,
            status: "connected",
            sta_ip: DEVICE_IP,
            ap_ip: "",
            rssi: -55,
        },
        target: TargetStatus {
            target_host: BRIDGE_HOST,
            target_port: BRIDGE_PORT,
            transport: "tcp",
        },
        audio: AudioStatus {
            input_line: 2,
            input_gain: 0,
            adc_attenuation_db: 9,
            sample_rate: 44100,
            channels: 2,
            bits_per_sample: 16,
        },
        analog_passthrough: AnalogPassthroughStatus {
            enabled: false,
            active: false,
            fault: None,
        },
        stream: StreamControlStatus { enabled: true },
        metrics: MetricsStatus {
            sequence: 1,
            packets: 56000,
            bytes: 9_856_000,
            read_errors: 0,
            short_reads: 0,
            queue_depth: 0,
            queue_drops_total: 0,
            stale_drops_total: 0,
            network_errors_total: 0,
            tls_handshake_failures_total: 0,
            reconnects_total: 0,
            send_stalls_total: 0,
            longest_send_stall_ms: 0,
            clip_threshold_abs: 32760,
            peak_abs_left: 21000,
            peak_abs_right: 20200,
            rms_left: 9800,
            rms_right: 9400,
            noise_floor: 12,
            clipped_samples_total: 0,
            playing: true,
        },
        diagnostics: DiagnosticsStatus {
            reset_reason: "power-on",
            last_fallback: "",
            last_ota: "",
        },
        system: SystemStatus {
            uptime_seconds: 3600,
            task_count: 14,
            heap: HeapStatus {
                free_bytes: 126_000,
                total_bytes: 323_100,
                minimum_free_bytes: 105_000,
                largest_free_block_bytes: 90_000,
            },
            nvs: NvsStatus {
                used_entries: 275,
                available_entries: 355,
                total_entries: 756,
            },
        },
        ota: OtaStatus {
            phase: "idle",
            bytes_written: 0,
            bytes_total: 0,
            latest_version: "",
            message: "",
            busy: false,
            rollback_available: false,
            rollback_version: "",
        },
        indicator: IndicatorStatus {
            available: true,
            state: "ready",
        },
        health: &health,
    };
    serde_json::to_value(&status).expect("serializable status example")
}

/// The same device's stored settings, as `GET /api/settings` reports them.
pub fn config() -> Value {
    let catalog = crate::board::builtin_catalog().expect("valid built-in catalog");
    let board = crate::board::resolve(&catalog, None).expect("default board");
    let config = ConfigResponse {
        device_name: "",
        ssid: SSID,
        target_host: BRIDGE_HOST,
        target_port: BRIDGE_PORT,
        transport: TransportStatus {
            contract_version: 1,
            mode: crate::transport::TransportMode::Cleartext,
            active_key_id: None,
            pending_key_id: None,
            pending_verified: false,
            rollback_key_id: None,
        },
        input_line: 2,
        input_gain: 0,
        adc_attenuation_db: 9,
        analog_passthrough_enabled: false,
        led_roles: board
            .leds
            .iter()
            .map(|led| LedRoleStatus {
                id: led.id.as_str(),
                role: led.default_role,
            })
            .collect(),
        button_actions: board
            .buttons
            .iter()
            .map(|button| ButtonActionStatus {
                id: button.id.as_str(),
                action: button.default_action,
            })
            .collect(),
        auto_update_schedule: AutoUpdateScheduleRequest::Daily,
        config_source: "nvs",
    };
    serde_json::to_value(&config).expect("serializable config example")
}
