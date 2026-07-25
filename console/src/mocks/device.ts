/**
 * In-memory fake device behind the generated device API. Reads serve one
 * state model, writes persist into it, and the unlock check, transport-key
 * lifecycle, and OTA phases follow the machines the firmware implements.
 * Writes parse `application/x-www-form-urlencoded` bodies, the encoding the
 * contract declares for every device settings operation.
 * `tests/mockCoverage.test.ts` pins the handler set to `docs/openapi.json`.
 */

import { type HttpHandler, HttpResponse, http, type JsonBodyType } from 'msw';
import contract from '../../../docs/openapi.json';
import type {
  AutoUpdateScheduleRequest,
  ButtonAction,
  LedRole,
  TransportMode,
} from '../generated/api';
import type {
  AudioProfileCatalog,
  BoardCatalog,
  BootLog,
  DeviceConfig,
  DeviceStatus,
  LoggedLine,
  LogsResponse,
  TransportKeyResponse,
} from '../lib/api';
import { deviceConfig, deviceStatus } from './fixtures';

/**
 * The admin key the fake device accepts once provisioned: the canonical
 * 48-hex shape, built from a repeated character so secret scanners see no
 * entropy in a test key.
 */
export const MOCK_ADMIN_KEY = 'a'.repeat(48);

/** The version an install lands on, so update recovery reads as applied. */
const MOCK_UPDATED_VERSION = '0.5.0-mock';

/**
 * Where in the journey the fake device starts: `steady` is a provisioned,
 * streaming device; `first-boot` is an unconfigured one on its setup network.
 */
export type DeviceScenario = 'steady' | 'first-boot';

/** Deterministic peak-level sweep, one step per status poll. */
const PEAK_STEPS = [30800, 24500, 28100, 21900, 26400, 31200];

/** Lines the fake device's log buffer holds before it evicts the oldest. */
const MOCK_LOG_CAPACITY = 60;

/** What a boot says before the console can reach it. */
const BOOT_LOG = [
  'boot: StreamLine 0.9.0 starting',
  "board: using board descriptor 'ai-thinker-esp32-audio-kit-v2-2-es8388'",
  'wifi: joined Study Wi-Fi, rssi -54',
  'codec: ES8388 ready at 48000 Hz',
  'httpd: console listening on :80',
];

/** How the boot before this one ended, so the previous-boot view has content. */
const PREVIOUS_BOOT_TAIL = [
  'ota: install requested for 0.9.0',
  'ota: downloaded 1904832 bytes, sha256 verified',
  'ota: signature verified, boot slot set',
  'system: restarting into the new image',
];

/** A parsed form body: every field arrives as a string. */
type FormBody = Partial<Record<string, string>>;

export class FakeDevice {
  readonly handlers: HttpHandler[];
  private status!: DeviceStatus;
  private config!: DeviceConfig;
  private profiles!: AudioProfileCatalog;
  /** The accepted admin key; null while the device has none (setup mode). */
  private adminKey!: string | null;
  private poll = 0;
  private keySerial = 0;
  /** This boot's captured log, and the one the last restart left behind. */
  private logLines: LoggedLine[] = [];
  private logSequence = 0;
  private logDropped = 0;
  private previousBootLog: BootLog | null = null;
  /** OTA phases still to play out, one per status poll. */
  private otaSteps: Array<() => void> = [];

  constructor(scenario: DeviceScenario = 'steady') {
    this.reset(scenario);
    this.handlers = [
      this.read('/api/status', () => this.nextStatus()),
      this.read('/api/settings', () => this.config),
      this.read('/api/health', () => this.status.health),
      this.read('/api/audio-profiles', () => this.profiles),
      this.read('/api/boards', () => this.boards()),
      this.read('/api/openapi.json', () => contract),
      this.readAuthorized('/api/logs', () => this.nextLogs()),
      http.get('/api/metrics', () => new HttpResponse(this.metricsText())),
      this.write('/api/unlock', () => ({ ok: true })),
      this.write('/api/settings/wifi', (body) => this.join(body)),
      this.write('/api/settings/target', (body) => {
        this.config.target_host = body.target_host ?? '';
        this.config.target_port = num(body.target_port) ?? this.config.target_port;
        this.status.target.target_host = this.config.target_host;
        this.status.target.target_port = this.config.target_port;
        return { ok: true };
      }),
      this.write('/api/settings/name', (body) => {
        this.config.device_name = body.name ?? '';
        this.status.device_name = this.config.device_name;
        return { ok: true };
      }),
      this.write('/api/settings/audio', (body) => {
        const audio = {
          input_line: num(body.input_line) ?? this.config.input_line,
          input_gain: num(body.input_gain) ?? this.config.input_gain,
          adc_attenuation_db: num(body.adc_attenuation_db) ?? this.config.adc_attenuation_db,
        };
        Object.assign(this.config, audio);
        Object.assign(this.status.audio, audio);
        return { ok: true };
      }),
      this.write('/api/settings/analog-passthrough', (body) => {
        const enabled = body.enabled === 'true';
        this.config.analog_passthrough_enabled = enabled;
        this.status.analog_passthrough.enabled = enabled;
        this.status.analog_passthrough.active = enabled;
        return { ok: true };
      }),
      this.write('/api/settings/led', (body) => {
        const led = this.config.led_roles.find((role) => role.id === body.id);
        if (!led) return reject(400, `unknown LED "${body.id}"`);
        led.role = (body.role ?? 'off') as LedRole;
        return { ok: true };
      }),
      this.write('/api/settings/button', (body) => {
        const button = this.config.button_actions.find((entry) => entry.id === body.id);
        if (!button) return reject(400, `unknown button "${body.id}"`);
        button.action = (body.action ?? 'none') as ButtonAction;
        return { ok: true };
      }),
      this.write('/api/stream', (body) => {
        this.status.stream.enabled = body.enabled === 'true';
        return { ok: true };
      }),
      this.write('/api/settings/board', (body) => this.selectBoard(body)),
      this.write('/api/settings/audio-profiles', (body) => this.replaceProfiles(body.catalog)),
      this.write('/api/settings/audio-profile', (body) =>
        this.activateProfile(body.profile_id ?? ''),
      ),
      this.write('/api/settings/admin-key', (body) => {
        if (!body.admin_secret) return reject(400, 'admin_secret is required');
        this.adminKey = body.admin_secret;
        return { ok: true };
      }),
      this.write('/api/settings/firmware', (body) => {
        this.config.auto_update_schedule = (body.auto_update_schedule ??
          'off') as AutoUpdateScheduleRequest;
        return { ok: true };
      }),
      this.write('/api/settings/transport', (body) => {
        const mode = (body.mode ?? 'cleartext') as TransportMode;
        this.transport().mode = mode;
        this.status.target.transport = mode === 'tls-psk' ? 'tls' : 'tcp';
        return { ok: true };
      }),
      this.write('/api/transport/keys/stage', () => this.stageKey()),
      this.write('/api/transport/keys/verify', () => {
        if (!this.transport().pending_key_id) return reject(400, 'no staged credential');
        this.transport().pending_verified = true;
        return { ok: true };
      }),
      this.write('/api/transport/keys/activate', () => this.activateKey()),
      this.write('/api/transport/keys/discard', () => {
        this.transport().pending_key_id = null;
        this.transport().pending_verified = false;
        return { ok: true };
      }),
      this.write('/api/transport/keys/rollback', () => {
        const transport = this.transport();
        if (!transport.rollback_key_id) return reject(400, 'no previous credential');
        transport.active_key_id = transport.rollback_key_id;
        transport.rollback_key_id = null;
        return { ok: true };
      }),
      this.write('/api/transport/keys/retire', () => {
        this.transport().rollback_key_id = null;
        return { ok: true };
      }),
      this.write('/api/transport/recover', () => {
        this.transport().mode = 'cleartext';
        this.status.target.transport = 'tcp';
        return this.stageKey();
      }),
      this.write('/api/ota/update', (body) => this.startUpdate(body)),
      this.write('/api/ota/check', () => {
        this.status.ota.phase = 'up-to-date';
        this.status.ota.latest_version = this.status.firmware_version;
        this.status.ota.message = `v${this.status.firmware_version} is the latest release`;
        return { ok: true };
      }),
      this.write('/api/ota/rollback', () => this.rollbackUpdate()),
      this.write('/api/restart', () => {
        this.status.system.uptime_seconds = 0;
        return { ok: true, rebooting: true };
      }),
      this.write('/api/factory-reset', () => {
        this.reset('first-boot');
        return { ok: true, rebooting: true };
      }),
    ];
  }

  private reset(scenario: DeviceScenario): void {
    if (scenario === 'steady') {
      this.status = deviceStatus({ metrics: { playing: true } });
      this.config = deviceConfig();
      this.adminKey = MOCK_ADMIN_KEY;
    } else {
      this.status = deviceStatus({
        mode: 'setup',
        auth_required: false,
        wifi: { ssid: '', status: 'setup', sta_ip: '', ap_ip: '192.168.71.1', rssi: 0 },
        target: { target_host: '' },
        // The contract example streams; an unconfigured device is silent.
        metrics: {
          playing: false,
          sequence: 0,
          packets: 0,
          bytes: 0,
          peak_abs_left: 0,
          peak_abs_right: 0,
          rms_left: 0,
          rms_right: 0,
        },
      });
      this.config = deviceConfig({ ssid: '', target_host: '' });
      this.adminKey = null;
    }
    this.status.ota.rollback_available = false;
    this.config.led_roles = [{ id: 'status', role: 'status' }];
    this.resetLog(scenario);
    this.profiles = {
      board_id: this.status.capabilities.board_id,
      schema_version: 1,
      profiles: [],
      active_profile_id: null,
    };
  }

  /** GET: reads are open on the device. */
  private read(path: string, body: () => JsonBodyType): HttpHandler {
    return http.get(path, () => HttpResponse.json(body()));
  }

  /**
   * GET behind the admin key, for a read that returns more than the device
   * publishes openly. Same rejection the firmware gives a missing key.
   */
  private readAuthorized(path: string, body: () => JsonBodyType): HttpHandler {
    return http.get(path, ({ request }) => {
      if (this.adminKey && request.headers.get('authorization') !== `Bearer ${this.adminKey}`) {
        return reject(401, 'unauthorized — unlock settings with the admin key');
      }
      return HttpResponse.json(body());
    });
  }

  /**
   * POST: writes require the admin key once the device has one, exactly as
   * `deviceFetch` sends it. The result may be an error `HttpResponse`.
   */
  private write(path: string, apply: (body: FormBody) => JsonBodyType | Response): HttpHandler {
    return http.post(path, async ({ request }) => {
      if (this.adminKey && request.headers.get('authorization') !== `Bearer ${this.adminKey}`) {
        return reject(401, 'unauthorized — unlock settings with the admin key');
      }
      const form = await request.formData().catch(() => null);
      const body: FormBody = form
        ? Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
        : {};
      const result = apply(body);
      return result instanceof Response ? result : HttpResponse.json(result);
    });
  }

  /** One status poll: audio moves while playing, and pending OTA phases advance. */
  private nextStatus(): DeviceStatus {
    const metrics = this.status.metrics;
    if (metrics.playing) {
      const peak = PEAK_STEPS[this.poll % PEAK_STEPS.length];
      metrics.sequence += 1;
      // A pause keeps capture and the meters running but nothing on the wire,
      // exactly like the firmware's capture gate.
      if (this.status.stream.enabled) {
        metrics.packets += 100;
        metrics.bytes += 176400;
      }
      metrics.peak_abs_left = peak;
      metrics.peak_abs_right = peak - 900;
      metrics.rms_left = Math.round(peak * 0.55);
      metrics.rms_right = Math.round(peak * 0.52);
    }
    this.status.system.uptime_seconds += 2;
    this.poll += 1;
    this.otaSteps.shift()?.();
    return this.status;
  }

  /**
   * First-join commissioning and the recovery form share this write: save
   * Wi-Fi, adopt a supplied admin key, and come up provisioned.
   */
  private join(body: FormBody): JsonBodyType | Response {
    const ssid = (body.ssid ?? '').trim();
    if (!ssid) return reject(400, 'ssid must not be empty');
    if (body.admin_secret) this.adminKey = body.admin_secret;
    this.config.ssid = ssid;
    if (body.target_host) {
      this.config.target_host = body.target_host;
      this.config.target_port = num(body.target_port) ?? this.config.target_port;
    }
    this.status.mode = 'provisioned';
    this.status.auth_required = this.adminKey !== null;
    Object.assign(this.status.wifi, {
      ssid,
      status: 'connected',
      sta_ip: '192.0.2.10',
      ap_ip: '',
      rssi: -55,
    });
    this.status.target.target_host = this.config.target_host;
    this.status.target.target_port = this.config.target_port;
    return { ok: true, rebooting: true };
  }

  private transport() {
    return this.config.transport;
  }

  private stageKey(): TransportKeyResponse {
    this.keySerial += 1;
    const serial = this.keySerial.toString(16);
    const transport = this.transport();
    transport.pending_key_id = `eli1-${serial.padStart(32, '0')}`;
    transport.pending_verified = false;
    return {
      contract_version: 1,
      key_id: transport.pending_key_id,
      psk: serial.padStart(64, '0'),
    };
  }

  private activateKey(): JsonBodyType | Response {
    const transport = this.transport();
    if (!transport.pending_key_id || !transport.pending_verified) {
      return reject(400, 'stage and verify a credential first');
    }
    transport.rollback_key_id = transport.active_key_id ?? null;
    transport.active_key_id = transport.pending_key_id;
    transport.pending_key_id = null;
    transport.pending_verified = false;
    transport.mode = 'tls-psk';
    this.status.target.transport = 'tls';
    return { ok: true };
  }

  private boards(): BoardCatalog {
    return {
      boards: [this.status.capabilities],
      selected_board: this.status.capabilities,
      selected_board_id: this.status.capabilities.board_id,
    };
  }

  private selectBoard(body: FormBody): JsonBodyType | Response {
    if (body.board_id && body.board_id !== this.status.capabilities.board_id) {
      return reject(400, `unknown board "${body.board_id}"`);
    }
    if (body.descriptor) {
      try {
        JSON.parse(body.descriptor);
      } catch {
        return reject(400, 'descriptor is not valid JSON');
      }
    }
    return { ok: true, rebooting: true };
  }

  private replaceProfiles(catalog: string | undefined): JsonBodyType | Response {
    let parsed: AudioProfileCatalog;
    try {
      parsed = JSON.parse(catalog ?? '') as AudioProfileCatalog;
    } catch {
      return reject(400, 'catalog is not valid JSON');
    }
    this.profiles = { ...parsed, board_id: this.status.capabilities.board_id };
    return { ok: true };
  }

  private activateProfile(profileId: string): JsonBodyType | Response {
    if (profileId && !this.profiles.profiles.some((profile) => profile.id === profileId)) {
      return reject(400, `unknown profile "${profileId}"`);
    }
    this.profiles.active_profile_id = profileId || null;
    return { ok: true };
  }

  /** Play the install out over the next status polls, ending on the new image. */
  private startUpdate(body: FormBody): JsonBodyType | Response {
    if (!body.url || !body.sha256) return reject(400, 'url and sha256 are required');
    const ota = this.status.ota;
    const from = this.status.firmware_version;
    ota.busy = true;
    ota.bytes_total = 1500000;
    ota.bytes_written = 0;
    ota.phase = 'downloading';
    this.otaSteps = [
      () => {
        ota.bytes_written = 750000;
      },
      () => {
        ota.bytes_written = ota.bytes_total;
        ota.phase = 'verifying';
      },
      () => {
        ota.phase = 'installed';
        ota.message = 'Restarting into the new image';
      },
      () => {
        this.status.firmware_version = MOCK_UPDATED_VERSION;
        this.status.system.uptime_seconds = 0;
        ota.busy = false;
        ota.phase = 'idle';
        ota.message = '';
        ota.rollback_available = true;
        ota.rollback_version = from;
      },
    ];
    return { ok: true, started: true };
  }

  private rollbackUpdate(): JsonBodyType | Response {
    const ota = this.status.ota;
    if (!ota.rollback_available) return reject(400, 'no previous image to roll back to');
    this.status.firmware_version = ota.rollback_version;
    this.status.system.uptime_seconds = 0;
    ota.rollback_available = false;
    ota.rollback_version = '';
    return { ok: true, rebooting: true };
  }

  /**
   * Start this boot's log. A provisioned device has restarted at least once,
   * so it can show the boot before this one; a first-boot device cannot.
   */
  private resetLog(scenario: DeviceScenario): void {
    this.logLines = [];
    this.logSequence = 0;
    this.logDropped = 0;
    for (const text of BOOT_LOG) this.appendLog(text);
    this.previousBootLog =
      scenario === 'steady'
        ? { lines: [...this.logLines, ...PREVIOUS_BOOT_TAIL.map(this.numbered, this)], dropped: 12 }
        : null;
  }

  private numbered(text: string, offset: number): LoggedLine {
    return { sequence: BOOT_LOG.length + offset, text };
  }

  private appendLog(text: string): void {
    this.logLines.push({
      sequence: this.logSequence,
      text: `I (${this.logSequence * 137}) ${text}`,
    });
    this.logSequence += 1;
    if (this.logLines.length > MOCK_LOG_CAPACITY) {
      this.logDropped += this.logLines.length - MOCK_LOG_CAPACITY;
      this.logLines = this.logLines.slice(-MOCK_LOG_CAPACITY);
    }
  }

  /**
   * One read of the device log. The device keeps logging between reads, so
   * each read adds a line and a follower sees the log move.
   */
  private nextLogs(): LogsResponse {
    this.appendLog(
      this.status.metrics.playing
        ? `stream: sent ${this.status.metrics.packets} packets`
        : 'capture: input silent, stream paused',
    );
    return {
      current: { lines: [...this.logLines], dropped: this.logDropped },
      previous: this.previousBootLog,
    };
  }

  private metricsText(): string {
    const metrics = this.status.metrics;
    return [
      `streamline_packets_total ${metrics.packets}`,
      `streamline_bytes_total ${metrics.bytes}`,
      `streamline_playing ${metrics.playing ? 1 : 0}`,
      '',
    ].join('\n');
  }
}

/** A form field that should carry a number, or null when absent or malformed. */
function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function reject(status: number, message: string): Response {
  return HttpResponse.json({ error: message }, { status });
}
