//! Runtime telemetry shared by status and metrics renderers.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetrySnapshot {
    pub firmware_version: &'static str,
    pub mode: &'static str,
    pub config_source: &'static str,
    pub web_server: bool,
    pub configuration_writable: bool,
    pub auth_required: bool,
    pub wifi: WifiTelemetry,
    pub target: TargetTelemetry,
    pub audio: AudioTelemetry,
    pub stream: StreamTelemetry,
    pub diagnostics: DiagnosticsTelemetry,
    pub ota: OtaTelemetry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WifiTelemetry {
    pub ssid: String,
    pub status: &'static str,
    pub sta_ip: String,
    pub ap_ip: String,
    pub rssi_dbm: i32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetTelemetry {
    pub host: String,
    pub port: u16,
    pub transport: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AudioTelemetry {
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
    pub sample_rate_hz: u32,
    pub channels: u8,
    pub bits_per_sample: u8,
    pub clip_threshold_abs: u16,
    pub peak_abs_left: u32,
    pub peak_abs_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub noise_floor: u32,
    pub clipped_samples_total: u64,
    pub playing: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamTelemetry {
    pub sequence: u32,
    pub packets_total: u64,
    pub bytes_total: u64,
    pub read_errors_total: u64,
    pub short_reads_total: u64,
    pub queue_depth: u32,
    pub queue_drops_total: u64,
    pub network_errors_total: u64,
    pub reconnects_total: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticsTelemetry {
    pub reset_reason: &'static str,
    pub last_fallback: String,
    pub last_ota: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OtaTelemetry {
    pub phase: &'static str,
    pub bytes_written: u32,
    pub bytes_total: u32,
    pub latest_version: String,
    pub message: String,
    pub busy: bool,
}
