//! Prometheus exposition for firmware runtime telemetry.

use core::fmt::{self, Write};

use crate::telemetry::TelemetrySnapshot;

/// Render the exposition text into any writer, so the HTTP adapter can stream
/// it without materializing the whole body.
pub fn render_prometheus_to(
    output: &mut impl fmt::Write,
    snapshot: &TelemetrySnapshot,
) -> fmt::Result {
    PrometheusWriter::new(output).snapshot(snapshot)
}

struct PrometheusWriter<W> {
    output: W,
}

impl<W: Write> PrometheusWriter<W> {
    fn new(output: W) -> Self {
        Self { output }
    }

    fn snapshot(&mut self, snapshot: &TelemetrySnapshot) -> fmt::Result {
        self.info(
            "streamline_firmware_info",
            "Firmware build and runtime mode.",
            &[
                ("version", snapshot.firmware_version),
                ("mode", snapshot.mode),
            ],
        )?;
        self.gauge(
            "streamline_uptime_seconds",
            "Seconds since the device booted.",
            snapshot.system.uptime_seconds,
        )?;
        self.gauge(
            "streamline_tasks",
            "FreeRTOS tasks currently scheduled.",
            snapshot.system.task_count,
        )?;
        self.gauge(
            "streamline_heap_free_bytes",
            "Free internal-RAM heap in bytes.",
            snapshot.system.heap.free_bytes,
        )?;
        self.gauge(
            "streamline_heap_total_bytes",
            "Total internal-RAM heap in bytes.",
            snapshot.system.heap.total_bytes,
        )?;
        self.gauge(
            "streamline_heap_minimum_free_bytes",
            "Lowest free internal-RAM heap observed since boot, in bytes.",
            snapshot.system.heap.minimum_free_bytes,
        )?;
        self.gauge(
            "streamline_heap_largest_free_block_bytes",
            "Largest allocatable internal-RAM block in bytes.",
            snapshot.system.heap.largest_free_block_bytes,
        )?;
        self.gauge(
            "streamline_nvs_used_entries",
            "Used entries in the NVS configuration partition.",
            snapshot.system.nvs.used_entries,
        )?;
        self.gauge(
            "streamline_nvs_available_entries",
            "Entries still writable in the NVS configuration partition.",
            snapshot.system.nvs.available_entries,
        )?;
        self.gauge(
            "streamline_nvs_total_entries",
            "Total entries in the NVS configuration partition.",
            snapshot.system.nvs.total_entries,
        )?;

        self.info(
            "streamline_wifi_info",
            "Wi-Fi identity and address labels.",
            &[
                ("hostname", &snapshot.wifi.hostname),
                ("ssid", &snapshot.wifi.ssid),
                ("status", snapshot.wifi.status),
                ("sta_ip", &snapshot.wifi.sta_ip),
                ("ap_ip", &snapshot.wifi.ap_ip),
            ],
        )?;
        self.gauge(
            "streamline_wifi_rssi_dbm",
            "Station RSSI in dBm.",
            snapshot.wifi.rssi_dbm,
        )?;

        let target_port = snapshot.target.port.to_string();
        self.info(
            "streamline_target_info",
            "Configured stream target.",
            &[
                ("host", &snapshot.target.host),
                ("port", &target_port),
                ("transport", snapshot.target.transport),
            ],
        )?;

        self.gauge(
            "streamline_audio_input_line",
            "Selected codec input line.",
            snapshot.audio.input_line,
        )?;
        self.gauge(
            "streamline_audio_input_gain",
            "Codec input gain setting.",
            snapshot.audio.input_gain,
        )?;
        self.gauge(
            "streamline_audio_adc_attenuation_db",
            "Codec ADC attenuation in dB.",
            snapshot.audio.adc_attenuation_db,
        )?;
        self.gauge(
            "streamline_audio_sample_rate_hz",
            "Captured sample rate in hertz.",
            snapshot.audio.sample_rate_hz,
        )?;
        self.gauge(
            "streamline_audio_channels",
            "Captured channel count.",
            snapshot.audio.channels,
        )?;
        self.gauge(
            "streamline_audio_bits_per_sample",
            "Captured PCM bits per sample.",
            snapshot.audio.bits_per_sample,
        )?;
        self.gauge(
            "streamline_stream_enabled",
            "Whether streaming to the bridge is enabled.",
            u8::from(snapshot.stream.enabled),
        )?;
        self.gauge(
            "streamline_stream_sequence",
            "Latest capture sequence number.",
            snapshot.stream.sequence,
        )?;
        self.counter(
            "streamline_stream_packets_total",
            "PCM packets sent to the bridge.",
            snapshot.stream.packets_total,
        )?;
        self.counter(
            "streamline_stream_bytes_total",
            "PCM payload bytes sent to the bridge.",
            snapshot.stream.bytes_total,
        )?;
        self.counter(
            "streamline_i2s_read_errors_total",
            "I2S read errors.",
            snapshot.stream.read_errors_total,
        )?;
        self.counter(
            "streamline_i2s_short_reads_total",
            "I2S reads with an unexpected byte count.",
            snapshot.stream.short_reads_total,
        )?;
        self.gauge(
            "streamline_queue_depth",
            "Current capture-to-network queue depth.",
            snapshot.stream.queue_depth,
        )?;
        self.counter(
            "streamline_queue_drops_total",
            "Packets dropped from the queue to bound latency.",
            snapshot.stream.queue_drops_total,
        )?;
        self.counter(
            "streamline_stale_drops_total",
            "In-flight packets dropped because retrying them outlived the latency bound.",
            snapshot.stream.stale_drops_total,
        )?;
        self.counter(
            "streamline_network_errors_total",
            "TCP send errors.",
            snapshot.stream.network_errors_total,
        )?;
        self.counter(
            "streamline_tls_handshake_failures_total",
            "TLS handshakes that did not authenticate the configured secure target.",
            snapshot.stream.tls_handshake_failures_total,
        )?;
        self.counter(
            "streamline_network_reconnects_total",
            "TCP reconnects after successful streaming began.",
            snapshot.stream.reconnects_total,
        )?;
        self.counter(
            "streamline_send_stalls_total",
            "Successful sends that held the pipeline 100 ms or longer.",
            snapshot.stream.send_stalls_total,
        )?;
        self.gauge(
            "streamline_longest_send_stall_ms",
            "Longest single send stall observed since boot.",
            snapshot.stream.longest_send_stall_ms,
        )?;
        self.gauge(
            "streamline_audio_clip_threshold_abs",
            "Absolute sample value treated as clipping.",
            snapshot.audio.clip_threshold_abs,
        )?;
        self.channel_gauge(
            "streamline_audio_peak_abs",
            "Latest absolute peak sample by channel.",
            snapshot.audio.peak_abs_left,
            snapshot.audio.peak_abs_right,
        )?;
        self.channel_gauge(
            "streamline_audio_rms",
            "Latest RMS sample value by channel.",
            snapshot.audio.rms_left,
            snapshot.audio.rms_right,
        )?;
        self.gauge(
            "streamline_audio_noise_floor",
            "Noise-floor RMS estimate the play detector calibrated to.",
            snapshot.audio.noise_floor,
        )?;
        self.counter(
            "streamline_audio_clipped_samples_total",
            "Clipped samples observed by the capture task.",
            snapshot.audio.clipped_samples_total,
        )?;
        self.gauge(
            "streamline_audio_playing",
            "Whether the signal gate currently treats input as playing.",
            u8::from(snapshot.audio.playing),
        )?;

        self.info(
            "streamline_ota_info",
            "OTA phase and latest version labels.",
            &[
                ("phase", snapshot.ota.phase),
                ("latest_version", &snapshot.ota.latest_version),
            ],
        )?;
        self.gauge(
            "streamline_ota_bytes_written",
            "OTA bytes written during the active update.",
            snapshot.ota.bytes_written,
        )?;
        self.gauge(
            "streamline_ota_bytes_total",
            "Expected OTA bytes for the active update.",
            snapshot.ota.bytes_total,
        )?;
        self.gauge(
            "streamline_ota_busy",
            "Whether OTA work is currently running.",
            u8::from(snapshot.ota.busy),
        )
    }

    fn info(&mut self, name: &str, text: &str, labels: &[(&str, &str)]) -> fmt::Result {
        self.help(name, text, MetricKind::Gauge)?;
        write!(self.output, "{name}")?;
        self.labels(labels)?;
        writeln!(self.output, " 1")
    }

    fn gauge(&mut self, name: &str, text: &str, value: impl fmt::Display) -> fmt::Result {
        self.metric(name, text, MetricKind::Gauge, value)
    }

    fn counter(&mut self, name: &str, text: &str, value: impl fmt::Display) -> fmt::Result {
        self.metric(name, text, MetricKind::Counter, value)
    }

    fn metric(
        &mut self,
        name: &str,
        text: &str,
        kind: MetricKind,
        value: impl fmt::Display,
    ) -> fmt::Result {
        self.help(name, text, kind)?;
        writeln!(self.output, "{name} {value}")
    }

    fn channel_gauge(&mut self, name: &str, text: &str, left: u32, right: u32) -> fmt::Result {
        self.help(name, text, MetricKind::Gauge)?;
        writeln!(self.output, r#"{name}{{channel="left"}} {left}"#)?;
        writeln!(self.output, r#"{name}{{channel="right"}} {right}"#)
    }

    fn help(&mut self, name: &str, text: &str, kind: MetricKind) -> fmt::Result {
        writeln!(self.output, "# HELP {name} {text}")?;
        writeln!(self.output, "# TYPE {name} {}", kind.as_str())
    }

    fn labels(&mut self, labels: &[(&str, &str)]) -> fmt::Result {
        if labels.is_empty() {
            return Ok(());
        }
        self.output.write_char('{')?;
        for (index, (key, value)) in labels.iter().enumerate() {
            if index > 0 {
                self.output.write_char(',')?;
            }
            write!(self.output, r#"{key}=""#)?;
            self.label_value(value)?;
            self.output.write_char('"')?;
        }
        self.output.write_char('}')
    }

    fn label_value(&mut self, value: &str) -> fmt::Result {
        for character in value.chars() {
            match character {
                '\\' => self.output.write_str(r"\\")?,
                '"' => self.output.write_str(r#"\""#)?,
                '\n' => self.output.write_str(r"\n")?,
                character => self.output.write_char(character)?,
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum MetricKind {
    Counter,
    Gauge,
}

impl MetricKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Counter => "counter",
            Self::Gauge => "gauge",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::render_prometheus_to;
    use crate::telemetry::{
        AnalogPassthroughTelemetry, AudioTelemetry, DiagnosticsTelemetry, HeapTelemetry,
        NvsTelemetry, OtaTelemetry, StreamTelemetry, SystemTelemetry, TargetTelemetry,
        TelemetrySnapshot, WifiTelemetry,
    };

    fn render_prometheus(snapshot: &TelemetrySnapshot) -> String {
        let mut output = String::new();
        render_prometheus_to(&mut output, snapshot).expect("writing to String cannot fail");
        output
    }

    #[test]
    fn renders_prometheus_metrics_from_snapshot() {
        let text = render_prometheus(&snapshot());

        assert_eq!(
            text,
            "# HELP streamline_firmware_info Firmware build and runtime mode.\n\
# TYPE streamline_firmware_info gauge\n\
streamline_firmware_info{version=\"0.3.3\",mode=\"provisioned\"} 1\n\
# HELP streamline_uptime_seconds Seconds since the device booted.\n\
# TYPE streamline_uptime_seconds gauge\n\
streamline_uptime_seconds 3600\n\
# HELP streamline_tasks FreeRTOS tasks currently scheduled.\n\
# TYPE streamline_tasks gauge\n\
streamline_tasks 12\n\
# HELP streamline_heap_free_bytes Free internal-RAM heap in bytes.\n\
# TYPE streamline_heap_free_bytes gauge\n\
streamline_heap_free_bytes 142000\n\
# HELP streamline_heap_total_bytes Total internal-RAM heap in bytes.\n\
# TYPE streamline_heap_total_bytes gauge\n\
streamline_heap_total_bytes 300000\n\
# HELP streamline_heap_minimum_free_bytes Lowest free internal-RAM heap observed since boot, in bytes.\n\
# TYPE streamline_heap_minimum_free_bytes gauge\n\
streamline_heap_minimum_free_bytes 120500\n\
# HELP streamline_heap_largest_free_block_bytes Largest allocatable internal-RAM block in bytes.\n\
# TYPE streamline_heap_largest_free_block_bytes gauge\n\
streamline_heap_largest_free_block_bytes 90000\n\
# HELP streamline_nvs_used_entries Used entries in the NVS configuration partition.\n\
# TYPE streamline_nvs_used_entries gauge\n\
streamline_nvs_used_entries 42\n\
# HELP streamline_nvs_available_entries Entries still writable in the NVS configuration partition.\n\
# TYPE streamline_nvs_available_entries gauge\n\
streamline_nvs_available_entries 630\n\
# HELP streamline_nvs_total_entries Total entries in the NVS configuration partition.\n\
# TYPE streamline_nvs_total_entries gauge\n\
streamline_nvs_total_entries 756\n\
# HELP streamline_wifi_info Wi-Fi identity and address labels.\n\
# TYPE streamline_wifi_info gauge\n\
streamline_wifi_info{hostname=\"streamline-a8b2.local\",ssid=\"studio\",status=\"connected\",sta_ip=\"192.0.2.50\",ap_ip=\"\"} 1\n\
# HELP streamline_wifi_rssi_dbm Station RSSI in dBm.\n\
# TYPE streamline_wifi_rssi_dbm gauge\n\
streamline_wifi_rssi_dbm -54\n\
# HELP streamline_target_info Configured stream target.\n\
# TYPE streamline_target_info gauge\n\
streamline_target_info{host=\"bridge.local\",port=\"39000\",transport=\"tcp\"} 1\n\
# HELP streamline_audio_input_line Selected codec input line.\n\
# TYPE streamline_audio_input_line gauge\n\
streamline_audio_input_line 2\n\
# HELP streamline_audio_input_gain Codec input gain setting.\n\
# TYPE streamline_audio_input_gain gauge\n\
streamline_audio_input_gain 0\n\
# HELP streamline_audio_adc_attenuation_db Codec ADC attenuation in dB.\n\
# TYPE streamline_audio_adc_attenuation_db gauge\n\
streamline_audio_adc_attenuation_db 0\n\
# HELP streamline_audio_sample_rate_hz Captured sample rate in hertz.\n\
# TYPE streamline_audio_sample_rate_hz gauge\n\
streamline_audio_sample_rate_hz 48000\n\
# HELP streamline_audio_channels Captured channel count.\n\
# TYPE streamline_audio_channels gauge\n\
streamline_audio_channels 2\n\
# HELP streamline_audio_bits_per_sample Captured PCM bits per sample.\n\
# TYPE streamline_audio_bits_per_sample gauge\n\
streamline_audio_bits_per_sample 16\n\
# HELP streamline_stream_enabled Whether streaming to the bridge is enabled.\n\
# TYPE streamline_stream_enabled gauge\n\
streamline_stream_enabled 1\n\
# HELP streamline_stream_sequence Latest capture sequence number.\n\
# TYPE streamline_stream_sequence gauge\n\
streamline_stream_sequence 15\n\
# HELP streamline_stream_packets_total PCM packets sent to the bridge.\n\
# TYPE streamline_stream_packets_total counter\n\
streamline_stream_packets_total 12\n\
# HELP streamline_stream_bytes_total PCM payload bytes sent to the bridge.\n\
# TYPE streamline_stream_bytes_total counter\n\
streamline_stream_bytes_total 4294967301\n\
# HELP streamline_i2s_read_errors_total I2S read errors.\n\
# TYPE streamline_i2s_read_errors_total counter\n\
streamline_i2s_read_errors_total 1\n\
# HELP streamline_i2s_short_reads_total I2S reads with an unexpected byte count.\n\
# TYPE streamline_i2s_short_reads_total counter\n\
streamline_i2s_short_reads_total 2\n\
# HELP streamline_queue_depth Current capture-to-network queue depth.\n\
# TYPE streamline_queue_depth gauge\n\
streamline_queue_depth 3\n\
# HELP streamline_queue_drops_total Packets dropped from the queue to bound latency.\n\
# TYPE streamline_queue_drops_total counter\n\
streamline_queue_drops_total 4\n\
# HELP streamline_stale_drops_total In-flight packets dropped because retrying them outlived the latency bound.\n\
# TYPE streamline_stale_drops_total counter\n\
streamline_stale_drops_total 5\n\
# HELP streamline_network_errors_total TCP send errors.\n\
# TYPE streamline_network_errors_total counter\n\
streamline_network_errors_total 6\n\
# HELP streamline_tls_handshake_failures_total TLS handshakes that did not authenticate the configured secure target.\n\
# TYPE streamline_tls_handshake_failures_total counter\n\
streamline_tls_handshake_failures_total 8\n\
# HELP streamline_network_reconnects_total TCP reconnects after successful streaming began.\n\
# TYPE streamline_network_reconnects_total counter\n\
streamline_network_reconnects_total 7\n\
# HELP streamline_send_stalls_total Successful sends that held the pipeline 100 ms or longer.\n\
# TYPE streamline_send_stalls_total counter\n\
streamline_send_stalls_total 9\n\
# HELP streamline_longest_send_stall_ms Longest single send stall observed since boot.\n\
# TYPE streamline_longest_send_stall_ms gauge\n\
streamline_longest_send_stall_ms 240\n\
# HELP streamline_audio_clip_threshold_abs Absolute sample value treated as clipping.\n\
# TYPE streamline_audio_clip_threshold_abs gauge\n\
streamline_audio_clip_threshold_abs 32000\n\
# HELP streamline_audio_peak_abs Latest absolute peak sample by channel.\n\
# TYPE streamline_audio_peak_abs gauge\n\
streamline_audio_peak_abs{channel=\"left\"} 111\n\
streamline_audio_peak_abs{channel=\"right\"} 222\n\
# HELP streamline_audio_rms Latest RMS sample value by channel.\n\
# TYPE streamline_audio_rms gauge\n\
streamline_audio_rms{channel=\"left\"} 33\n\
streamline_audio_rms{channel=\"right\"} 44\n\
# HELP streamline_audio_noise_floor Noise-floor RMS estimate the play detector calibrated to.\n\
# TYPE streamline_audio_noise_floor gauge\n\
streamline_audio_noise_floor 21\n\
# HELP streamline_audio_clipped_samples_total Clipped samples observed by the capture task.\n\
# TYPE streamline_audio_clipped_samples_total counter\n\
streamline_audio_clipped_samples_total 5\n\
# HELP streamline_audio_playing Whether the signal gate currently treats input as playing.\n\
# TYPE streamline_audio_playing gauge\n\
streamline_audio_playing 1\n\
# HELP streamline_ota_info OTA phase and latest version labels.\n\
# TYPE streamline_ota_info gauge\n\
streamline_ota_info{phase=\"idle\",latest_version=\"\"} 1\n\
# HELP streamline_ota_bytes_written OTA bytes written during the active update.\n\
# TYPE streamline_ota_bytes_written gauge\n\
streamline_ota_bytes_written 0\n\
# HELP streamline_ota_bytes_total Expected OTA bytes for the active update.\n\
# TYPE streamline_ota_bytes_total gauge\n\
streamline_ota_bytes_total 0\n\
# HELP streamline_ota_busy Whether OTA work is currently running.\n\
# TYPE streamline_ota_busy gauge\n\
streamline_ota_busy 0\n"
        );
    }

    #[test]
    fn escapes_label_values_for_prometheus_text() {
        let mut snapshot = snapshot();
        snapshot.wifi.ssid = "studio \"line\"\nbackslash\\".to_owned();
        snapshot.target.host = "bridge\"lan".to_owned();

        let text = render_prometheus(&snapshot);

        assert!(text.contains(",ssid=\"studio \\\"line\\\"\\nbackslash\\\\\""));
        assert!(text.contains("streamline_target_info{host=\"bridge\\\"lan\""));
    }

    fn snapshot() -> TelemetrySnapshot {
        TelemetrySnapshot {
            firmware_version: "0.3.3",
            device_name: "Study CD player".to_owned(),
            mode: "provisioned",
            config_source: "nvs",
            web_server: true,
            configuration_writable: true,
            auth_required: false,
            wifi: WifiTelemetry {
                hostname: "streamline-a8b2.local".to_owned(),
                ssid: "studio".to_owned(),
                status: "connected",
                sta_ip: "192.0.2.50".to_owned(),
                ap_ip: String::new(),
                rssi_dbm: -54,
            },
            target: TargetTelemetry {
                host: "bridge.local".to_owned(),
                port: 39_000,
                transport: "tcp",
            },
            audio: AudioTelemetry {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: 0,
                sample_rate_hz: 48_000,
                channels: 2,
                bits_per_sample: 16,
                clip_threshold_abs: 32_000,
                peak_abs_left: 111,
                peak_abs_right: 222,
                rms_left: 33,
                rms_right: 44,
                noise_floor: 21,
                clipped_samples_total: 5,
                playing: true,
            },
            analog_passthrough: AnalogPassthroughTelemetry::default(),
            stream: StreamTelemetry {
                enabled: true,
                sequence: 15,
                packets_total: 12,
                bytes_total: 4_294_967_301,
                read_errors_total: 1,
                short_reads_total: 2,
                queue_depth: 3,
                queue_drops_total: 4,
                stale_drops_total: 5,
                network_errors_total: 6,
                tls_handshake_failures_total: 8,
                reconnects_total: 7,
                send_stalls_total: 9,
                longest_send_stall_ms: 240,
            },
            diagnostics: DiagnosticsTelemetry {
                reset_reason: "software",
                last_fallback: String::new(),
                last_ota: String::new(),
            },
            system: SystemTelemetry {
                uptime_seconds: 3_600,
                task_count: 12,
                heap: HeapTelemetry {
                    free_bytes: 142_000,
                    total_bytes: 300_000,
                    minimum_free_bytes: 120_500,
                    largest_free_block_bytes: 90_000,
                },
                nvs: NvsTelemetry {
                    used_entries: 42,
                    available_entries: 630,
                    total_entries: 756,
                },
            },
            ota: OtaTelemetry {
                phase: "idle",
                latest_version: String::new(),
                bytes_written: 0,
                bytes_total: 0,
                message: String::new(),
                busy: false,
                rollback_available: false,
                rollback_version: String::new(),
            },
            status_indicator_visible: true,
        }
    }
}
