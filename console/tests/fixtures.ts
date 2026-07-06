import type { DeviceStatus } from '../src/lib/api';

/**
 * A healthy provisioned device; override the fields the test cares about.
 * Nested `wifi`/`metrics`/… overrides merge into the defaults.
 */
export function deviceStatus(
  overrides: Partial<
    Omit<DeviceStatus, 'wifi' | 'target' | 'audio' | 'metrics' | 'diagnostics' | 'ota' | 'health'>
  > & {
    wifi?: Partial<DeviceStatus['wifi']>;
    target?: Partial<DeviceStatus['target']>;
    audio?: Partial<DeviceStatus['audio']>;
    metrics?: Partial<DeviceStatus['metrics']>;
    diagnostics?: Partial<DeviceStatus['diagnostics']>;
    ota?: Partial<DeviceStatus['ota']>;
    health?: Partial<DeviceStatus['health']>;
  } = {},
): DeviceStatus {
  const { wifi, target, audio, metrics, diagnostics, ota, health, ...top } = overrides;
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
      adc_atten_db: 9,
      sample_rate: 44100,
      channels: 2,
      bits_per_sample: 16,
      ...audio,
    },
    metrics: {
      sequence: 1,
      packets: 0,
      bytes: 0,
      read_errors: 0,
      short_reads: 0,
      queue_depth: 0,
      queue_drops_total: 0,
      network_errors_total: 0,
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
    ota: {
      phase: 'idle',
      bytes_written: 0,
      bytes_total: 0,
      latest_version: '',
      message: '',
      busy: false,
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
