//! Runtime telemetry shared by status and metrics renderers.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetrySnapshot {
    pub firmware_version: &'static str,
    /// Friendly device name; empty when unnamed.
    pub device_name: String,
    pub mode: &'static str,
    pub config_source: &'static str,
    pub web_server: bool,
    pub configuration_writable: bool,
    pub auth_required: bool,
    pub wifi: WifiTelemetry,
    pub target: TargetTelemetry,
    pub audio: AudioTelemetry,
    pub analog_passthrough: AnalogPassthroughTelemetry,
    pub stream: StreamTelemetry,
    pub diagnostics: DiagnosticsTelemetry,
    pub system: SystemTelemetry,
    pub ota: OtaTelemetry,
    /// A board LED currently renders the device status, so the indicator is
    /// visible somewhere.
    pub status_indicator_visible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WifiTelemetry {
    pub hostname: String,
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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AnalogPassthroughTelemetry {
    pub enabled: bool,
    pub active: bool,
    pub fault: Option<String>,
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
    pub stale_drops_total: u64,
    pub network_errors_total: u64,
    pub tls_handshake_failures_total: u64,
    pub reconnects_total: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticsTelemetry {
    pub reset_reason: &'static str,
    pub last_fallback: String,
    pub last_ota: String,
}

/// Device resource headroom sampled at read time: how much RAM and NVS storage
/// remain, how long the device has been up, and how many tasks are scheduled.
/// The reads are cheap and pull-only, so nothing is collected until a client
/// asks for status or metrics.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SystemTelemetry {
    pub uptime_seconds: u64,
    /// FreeRTOS tasks currently scheduled across both cores.
    pub task_count: u32,
    pub heap: HeapTelemetry,
    pub nvs: NvsTelemetry,
}

/// Internal RAM heap, in bytes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HeapTelemetry {
    pub free_bytes: u32,
    pub total_bytes: u32,
    /// Lowest free heap observed since boot; the all-time worst case that a
    /// leak or a demanding moment drove the device to.
    pub minimum_free_bytes: u32,
    /// Largest single allocation the heap can still satisfy; a fragmentation
    /// signal that free bytes alone hides.
    pub largest_free_block_bytes: u32,
}

/// NVS configuration partition usage, in 32-byte entries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NvsTelemetry {
    pub used_entries: u32,
    /// Entries still writable for data, excluding reserved bookkeeping.
    pub available_entries: u32,
    pub total_entries: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OtaTelemetry {
    pub phase: &'static str,
    pub bytes_written: u32,
    pub bytes_total: u32,
    pub latest_version: String,
    pub message: String,
    pub busy: bool,
    /// The inactive slot holds a valid image to roll back into.
    pub rollback_available: bool,
    /// The version that a rollback would return to; empty when unavailable or
    /// unreadable.
    pub rollback_version: String,
}
