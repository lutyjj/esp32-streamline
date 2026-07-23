//! Runtime status, health, telemetry, and metrics handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    adapters::wifi,
    api, board,
    health::{HealthReport, Severity},
    indicator,
    levels::CLIP_THRESHOLD_ABS,
    metrics,
    telemetry::{
        AnalogPassthroughTelemetry, AudioTelemetry, DiagnosticsTelemetry, OtaTelemetry,
        StreamTelemetry, TargetTelemetry, TelemetrySnapshot, WifiTelemetry,
    },
};

use super::super::{
    responses::{body_writer, json_response},
    ApiState, ContractServer, Mode,
};

const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state_for_status = Arc::clone(state);
    server.handler(api::STATUS, move |request| {
        let snapshot = telemetry_snapshot(&state_for_status);
        json_response(
            request,
            200,
            &api::StatusResponse::from_snapshot(
                &snapshot,
                state_for_status.board.as_ref(),
                state_for_status.health.as_ref(),
            ),
        )
    })?;

    // A scriptable liveness probe: 200 when the startup checks found nothing
    // blocking, 503 when they did. The same verdict rides `/api/status` under
    // `health` for the console; this endpoint is the status code a monitor or
    // `curl` can read without parsing JSON.
    let state_for_health = Arc::clone(state);
    server.handler(api::HEALTH, move |request| {
        let health = &state_for_health.health;
        let code = if health.status == Severity::Blocking {
            503
        } else {
            200
        };
        json_response(request, code, health.as_ref())
    })?;

    let state_for_metrics = Arc::clone(state);
    server.handler(api::METRICS, move |request| {
        let snapshot = telemetry_snapshot(&state_for_metrics);
        let mut writer = body_writer(request, 200, PROMETHEUS_CONTENT_TYPE)?;
        metrics::render_prometheus_to(&mut FmtToIo(&mut writer), &snapshot)
            .map_err(|_| anyhow::anyhow!("prometheus exposition write failed"))?;
        std::io::Write::flush(&mut writer)?;
        anyhow::Ok(())
    })
}

/// Adapt a `std::io` writer to `core::fmt::Write` for the exposition renderer.
struct FmtToIo<'a, W: std::io::Write>(&'a mut W);

impl<W: std::io::Write> core::fmt::Write for FmtToIo<'_, W> {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        self.0
            .write_all(text.as_bytes())
            .map_err(|_| core::fmt::Error)
    }
}

fn telemetry_snapshot(state: &ApiState) -> TelemetrySnapshot {
    let (last_fallback, last_ota) = match state.store.lock() {
        Ok(store) => (store.last_fallback(), store.last_ota()),
        Err(_) => (String::new(), String::new()),
    };
    let config = state.config.lock().expect("configuration lock poisoned");
    let passthrough = state
        .analog_passthrough
        .lock()
        .expect("analog passthrough lock poisoned")
        .clone();
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
            transport: config.transport.mode.as_str(),
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
        analog_passthrough: AnalogPassthroughTelemetry {
            enabled: config.analog_passthrough_enabled,
            active: passthrough.active,
            fault: passthrough.fault,
        },
        stream: StreamTelemetry {
            // Without a capture task there is nothing to pause; report the
            // boot state so a setup-mode console never claims a pause.
            enabled: state.stream.is_none() || metrics.streaming_enabled,
            sequence: metrics.sequence,
            packets_total: metrics.packets,
            bytes_total: metrics.bytes,
            read_errors_total: metrics.read_errors,
            short_reads_total: metrics.short_reads,
            queue_depth: metrics.queue_depth,
            queue_drops_total: metrics.queue_drops,
            stale_drops_total: metrics.stale_drops,
            network_errors_total: metrics.network_errors,
            tls_handshake_failures_total: metrics.tls_handshake_failures,
            reconnects_total: metrics.reconnects,
            send_stalls_total: metrics.send_stalls,
            longest_send_stall_ms: metrics.longest_send_stall_ms,
        },
        diagnostics: DiagnosticsTelemetry {
            reset_reason: reset_reason(),
            last_fallback,
            last_ota,
        },
        system: crate::adapters::system::snapshot(),
        ota: OtaTelemetry {
            phase: ota.phase,
            bytes_written: ota.bytes_written,
            bytes_total: ota.bytes_total,
            latest_version: ota.latest_version,
            message: ota.message,
            busy: ota.busy,
            rollback_available: rollback.is_some(),
            rollback_version: rollback.clone().unwrap_or_default(),
            signed_updates: crate::adapters::ota::SIGNED_UPDATES,
        },
        status_indicator_visible: config.shows_status_indicator(state.board.as_ref()),
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
            analog_passthrough: api::AnalogPassthroughStatus {
                enabled: snapshot.analog_passthrough.enabled,
                active: snapshot.analog_passthrough.active,
                fault: snapshot.analog_passthrough.fault.as_deref(),
            },
            stream: api::StreamControlStatus {
                enabled: snapshot.stream.enabled,
            },
            metrics: api::MetricsStatus {
                sequence: snapshot.stream.sequence,
                packets: snapshot.stream.packets_total,
                bytes: snapshot.stream.bytes_total,
                read_errors: snapshot.stream.read_errors_total,
                short_reads: snapshot.stream.short_reads_total,
                queue_depth: snapshot.stream.queue_depth,
                queue_drops_total: snapshot.stream.queue_drops_total,
                stale_drops_total: snapshot.stream.stale_drops_total,
                network_errors_total: snapshot.stream.network_errors_total,
                tls_handshake_failures_total: snapshot.stream.tls_handshake_failures_total,
                reconnects_total: snapshot.stream.reconnects_total,
                send_stalls_total: snapshot.stream.send_stalls_total,
                longest_send_stall_ms: snapshot.stream.longest_send_stall_ms,
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
            system: api::SystemStatus {
                uptime_seconds: snapshot.system.uptime_seconds,
                task_count: snapshot.system.task_count,
                heap: api::HeapStatus {
                    free_bytes: snapshot.system.heap.free_bytes,
                    total_bytes: snapshot.system.heap.total_bytes,
                    minimum_free_bytes: snapshot.system.heap.minimum_free_bytes,
                    largest_free_block_bytes: snapshot.system.heap.largest_free_block_bytes,
                },
                nvs: api::NvsStatus {
                    used_entries: snapshot.system.nvs.used_entries,
                    available_entries: snapshot.system.nvs.available_entries,
                    total_entries: snapshot.system.nvs.total_entries,
                },
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
                signed_updates: snapshot.ota.signed_updates,
            },
            indicator: api::IndicatorStatus {
                available: snapshot.status_indicator_visible,
                state: indicator_state.as_str(),
            },
            health,
        }
    }
}
