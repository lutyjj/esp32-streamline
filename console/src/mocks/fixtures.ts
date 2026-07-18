/**
 * Coherent base shapes for both consoles' APIs, typed against the generated
 * client so a contract change fails `tsc` here. Unit tests and the fake
 * backends in this folder both build on them.
 */

import type {
  BridgeStatus,
  RecordingCapabilities,
  SourceSnapshot,
  TransportSnapshot,
} from '../generated/bridge';
import type { DeviceConfig, DeviceStatus, TransportStatus } from '../lib/api';

/** A cleartext transport status; override the fields a test cares about. */
export function transportStatus(overrides: Partial<TransportStatus> = {}): TransportStatus {
  return {
    contract_version: 1,
    mode: 'cleartext',
    active_key_id: null,
    pending_key_id: null,
    pending_verified: false,
    rollback_key_id: null,
    ...overrides,
  };
}

/**
 * A provisioned device's settings with a configured bridge target; override the
 * fields the test cares about.
 */
export function deviceConfig(overrides: Partial<DeviceConfig> = {}): DeviceConfig {
  return {
    device_name: '',
    ssid: 'home',
    target_host: '192.0.2.20',
    target_port: 39000,
    transport: transportStatus(),
    auto_update_schedule: 'daily',
    input_line: 2,
    input_gain: 0,
    adc_attenuation_db: 9,
    analog_passthrough_enabled: false,
    led_roles: [],
    config_source: 'nvs',
    ...overrides,
  };
}

/**
 * A healthy provisioned device; override the fields the test cares about.
 * Nested `wifi`/`metrics`/… overrides merge into the defaults.
 */
export function deviceStatus(
  overrides: Partial<
    Omit<
      DeviceStatus,
      'wifi' | 'target' | 'audio' | 'metrics' | 'diagnostics' | 'system' | 'ota' | 'health'
    >
  > & {
    wifi?: Partial<DeviceStatus['wifi']>;
    target?: Partial<DeviceStatus['target']>;
    audio?: Partial<DeviceStatus['audio']>;
    metrics?: Partial<DeviceStatus['metrics']>;
    diagnostics?: Partial<DeviceStatus['diagnostics']>;
    system?: Partial<DeviceStatus['system']>;
    ota?: Partial<DeviceStatus['ota']>;
    health?: Partial<DeviceStatus['health']>;
  } = {},
): DeviceStatus {
  const { wifi, target, audio, metrics, diagnostics, system, ota, health, ...top } = overrides;
  return {
    firmware_version: '0.4.0',
    device_name: '',
    mode: 'provisioned',
    config_source: 'nvs',
    web_server: true,
    configuration_writable: true,
    auth_required: true,
    capabilities: {
      board_id: 'ai-thinker-esp32-audio-kit-v2-2-es8388',
      board: 'Ai-Thinker ESP32 Audio Kit v2.2 (ES8388)',
      codec: { driver: 'es8388', i2c_address: 0x10 },
      pins: {
        i2c: { sda: 33, scl: 32 },
        i2s: { mclk: 0, bclk: 27, ws: 25, din: 35 },
      },
      leds: [
        {
          id: 'status',
          label: 'Status light (D4)',
          gpio: 22,
          active_low: false,
          default_role: 'status',
        },
      ],
      analog_passthrough: { output_line: 2, label: '3.5 mm output' },
      input_lines: [
        { line: 2, label: 'Line 2 — 3.5 mm jack' },
        { line: 1, label: 'Line 1 — header pins' },
      ],
      input_gain_max: 100,
      adc_atten_max_db: 48,
    },
    wifi: {
      hostname: 'streamline-0000.local',
      ssid: 'home',
      status: 'connected',
      sta_ip: '192.0.2.10',
      ap_ip: '',
      rssi: -55,
      ...wifi,
    },
    target: { target_host: '192.0.2.20', target_port: 39000, transport: 'tcp', ...target },
    audio: {
      input_line: 2,
      input_gain: 0,
      adc_attenuation_db: 9,
      sample_rate: 44100,
      channels: 2,
      bits_per_sample: 16,
      ...audio,
    },
    analog_passthrough: { enabled: false, active: false, fault: null },
    metrics: {
      sequence: 1,
      packets: 0,
      bytes: 0,
      read_errors: 0,
      short_reads: 0,
      queue_depth: 0,
      queue_drops_total: 0,
      stale_drops_total: 0,
      network_errors_total: 0,
      tls_handshake_failures_total: 0,
      reconnects_total: 0,
      clip_threshold_abs: 32760,
      peak_abs_left: 0,
      peak_abs_right: 0,
      rms_left: 0,
      rms_right: 0,
      noise_floor: 0,
      clipped_samples_total: 0,
      playing: false,
      ...metrics,
    },
    diagnostics: { reset_reason: 'power-on', last_fallback: '', last_ota: '', ...diagnostics },
    system: {
      uptime_seconds: 3600,
      task_count: 14,
      heap: {
        free_bytes: 126000,
        total_bytes: 323100,
        minimum_free_bytes: 105000,
        largest_free_block_bytes: 90000,
      },
      nvs: { used_entries: 275, available_entries: 355, total_entries: 756 },
      ...system,
    },
    indicator: { available: true, state: 'ready' },
    ota: {
      phase: 'idle',
      bytes_written: 0,
      bytes_total: 0,
      latest_version: '',
      message: '',
      busy: false,
      rollback_available: false,
      rollback_version: '',
      ...ota,
    },
    health: {
      status: 'ok',
      checks: [
        {
          id: 'codec',
          status: 'ok',
          severity: 'ok',
          detail: 'The codec answered and is streaming-ready.',
          remedy: null,
          fixable: false,
        },
      ],
      ...health,
    },
    ...top,
  };
}

/** A cleartext bridge PCM listener with no enrolled credential. */
export function transportSnapshot(overrides: Partial<TransportSnapshot> = {}): TransportSnapshot {
  return {
    contract_version: 1,
    mode: 'cleartext',
    port: 39000,
    configurable: true,
    key_ids: [],
    auth_failures: 0,
    auth_successes: 0,
    ...overrides,
  };
}

/** One device streaming cleanly to the bridge. */
export function sourceSnapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    started_at: 1_700_000_000,
    uptime_seconds: 320,
    rate: 44100,
    packets: 56000,
    frames: 2464000,
    bytes: 9856000,
    played_frames: 2463000,
    buffered_packets: 24,
    playout_buffer_packets: 32,
    client_buffer_chunks: 64,
    max_outage_silence_packets: 200,
    buffer_ready_at: 1_700_000_001,
    last_packet_at: 1_700_000_320,
    last_playout_at: 1_700_000_320,
    highest_seq: 56000,
    last_seq: 56000,
    playout_seq: 55976,
    packet_frames: 441,
    lost: 0,
    late: 0,
    duplicate: 0,
    reordered: 0,
    concealed: 0,
    underruns: 0,
    clients: 1,
    client_streams: [],
    client_queue_drops: 0,
    slow_clients: 0,
    tcp_connections: 1,
    tcp_disconnects: 0,
    tcp_errors: 0,
    levels: { rms_left: 9800, rms_right: 9400, peak_left: 21000, peak_right: 20200 },
    lifecycle: {
      state: 'connected',
      admission: 'open',
      transport: 'cleartext',
      dynamic: true,
      peer_ip: '192.0.2.10',
      http_clients: 1,
      recording_sessions: 0,
      idle_seconds: 0,
      eviction_idle_seconds: null,
    },
    ...overrides,
  };
}

/**
 * A reachable bridge with an API token configured; override the fields the
 * caller cares about. Nested `transport` overrides merge into the default.
 */
export function bridgeStatus(
  overrides: Partial<Omit<BridgeStatus, 'transport'>> & {
    transport?: Partial<TransportSnapshot>;
  } = {},
): BridgeStatus {
  const { transport, ...top } = overrides;
  return {
    bridge_version: '0.4.0',
    api_token_configured: true,
    sources: {},
    transport: transportSnapshot(transport),
    ...top,
  };
}

/** WAV recording support as the bridge advertises it. */
export function recordingCapabilities(
  overrides: Partial<RecordingCapabilities> = {},
): RecordingCapabilities {
  return {
    enabled: true,
    format: {
      container: 'wav',
      codec: 'pcm_s16le',
      sample_rate: 44100,
      channels: 2,
      bits_per_sample: 16,
      bytes_per_second: 176400,
    },
    limits: {
      max_duration_seconds: 7200,
      max_gap_seconds: 300,
      max_title_chars: 80,
      min_free_bytes: 104857600,
      queue_chunks: 256,
    },
    ...overrides,
  };
}
