/**
 * In-memory fake device behind the generated device API. Reads serve one
 * state model, writes persist into it, and the unlock check, transport-key
 * lifecycle, and OTA phases follow the machines the firmware implements.
 * Writes decode their `application/x-www-form-urlencoded` bodies and check
 * them against the contract's generated rules. The generated handlers answer
 * every operation the fake does not keep state for.
 */

import { type HttpHandler, HttpResponse, http, type JsonBodyType } from 'msw';
import * as v from 'valibot';
import contract from '../../../../docs/openapi.json';
import type {
  AudioProfileCatalog,
  BoardCatalogResponse,
  BootLog,
  DiscoveredBridge,
  GetOpenapi200,
  LogsResponse,
  SettingsResponse,
  StatusResponse,
  TransportKeyResponse,
} from '../../generated/api';
import {
  getGetBoardsMockHandler,
  getGetCoredumpMockHandler,
  getGetHealthMockHandler,
  getGetMetricsMockHandler,
  getGetOpenapiMockHandler,
  getStreamLineDeviceAPIMock,
} from '../../generated/api.msw';
import { AUTHENTICATED_READS, RESTARTING_WRITES } from '../../generated/facts';
import * as rules from '../../generated/rules';

/** One captured line as the fake device holds it before rendering to text. */
interface MockLogLine {
  sequence: number;
  text: string;
}

import { DIGEST_USERNAME, digestResponse, parseDigestFields } from '../lib/digest';
import { deviceConfig, deviceStatus, discoveredBridges, setupNetwork } from './fixtures';

/**
 * The admin key the fake device accepts once provisioned: the canonical
 * 48-hex shape, built from a repeated character so secret scanners see no
 * entropy in a test key.
 */
export const MOCK_ADMIN_KEY = 'a'.repeat(48);

/** The version a custom image, or an install with no newer release, lands on. */
const MOCK_UPDATED_VERSION = '0.5.0-mock';

/** The realm the firmware names in every digest challenge. */
const DIGEST_REALM = 'streamline';

/**
 * Where in the journey the fake device starts: `steady` is a provisioned,
 * streaming device; `first-boot` is an unconfigured one on its setup network;
 * `recovery` is a provisioned one that cannot find its saved Wi-Fi and serves
 * its setup network while it retries.
 */
export type DeviceScenario = 'steady' | 'first-boot' | 'recovery';

/** What a device off its home network reports: no capture, nothing sent. */
const SILENT_METRICS = {
  playing: false,
  sequence: 0,
  packets_total: 0,
  bytes_total: 0,
  peak_abs_left: 0,
  peak_abs_right: 0,
  rms_left: 0,
  rms_right: 0,
};

/** The setup network's Wi-Fi fields, as the firmware reports them. */
const SETUP_NETWORK_WIFI = { status: 'ap', sta_ip: '', ap_ip: '192.168.71.1', rssi_dbm: 0 };

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

/**
 * The networks the fake device can reach, with the password each takes; null
 * is an open network. A join elsewhere fails the way the firmware reports it.
 */
const NETWORKS_IN_RANGE: Readonly<Record<string, string | null>> = {
  home: 'correct horse',
  'Cafe guest': null,
};

/** Status reads the device stays silent for while it restarts and tries a network. */
const JOIN_ATTEMPT_READS = 4;

/** Status reads until a restarted device answers again; the last one is answered. */
const RESTART_READS = 2;

type JoinFailure = NonNullable<StatusResponse['wifi']['join_failure']>;

/** The codec check of a board whose codec answered, and of one whose did not. */
const CODEC_RUNS = {
  status: 'ok',
  severity: 'ok',
  detail: 'The audio codec answered.',
  remedy: null,
} as const;
const CODEC_SILENT = {
  status: 'fail',
  severity: 'blocking',
  detail: 'The audio codec did not answer.',
  remedy: 'Check the board selection, then restart the device.',
} as const;

/** A request's generated rule: the fields it takes, and the values it accepts. */
type RequestRule<T> = v.GenericSchema<unknown, T> & { entries: Record<string, unknown> };

export class FakeDevice {
  readonly handlers: HttpHandler[];
  /** What a browse of the device's network finds; tests replace it. */
  bridges: DiscoveredBridge[] = discoveredBridges();

  /** Whether the source plays into the input; a quiet input is gated to silence records. */
  set inputPlaying(playing: boolean) {
    this.status.metrics.playing = playing;
  }

  /** Whether the codec started; a device without it applies new levels at its next start. */
  set codecRunning(running: boolean) {
    const codec = this.status.health.checks.find((check) => check.id === 'codec');
    if (codec) {
      Object.assign(codec, running ? CODEC_RUNS : CODEC_SILENT);
    }
    this.status.health.status = running ? 'ok' : 'blocking';
  }
  private status!: StatusResponse;
  private config!: SettingsResponse;
  private profiles!: AudioProfileCatalog;
  /** The accepted admin key; null while the device has none (setup mode). */
  private adminKey!: string | null;
  /** The saved Wi-Fi password, which the device never reads back. */
  private wifiPassword = '';
  /** Status reads before the device answers on this browser's network again; Infinity once it left. */
  private absentReads = 0;
  /** What the device looks like when it answers again. */
  private onReturn: (() => void) | null = null;
  private poll = 0;
  private keySerial = 0;
  /** This boot's captured log, and the one the last restart left behind. */
  private logLines: MockLogLine[] = [];
  private logSequence = 0;
  private logDropped = 0;
  private previousBootLog: BootLog | null = null;
  /** OTA phases still to play out, one per status poll. */
  private otaSteps: Array<() => void> = [];
  /** The stored crash dump's bytes; null while none is stored. */
  private coredump: ArrayBuffer | null = null;
  /** The setup network's credentials, stable for the device's life. */
  private setupNetwork = setupNetwork();
  /** The live digest nonce and its accepted count, as the firmware tracks. */
  private nonce: { value: string; lastNc: number } | null = null;
  private nonceSerial = 0;

  constructor(scenario: DeviceScenario = 'steady') {
    this.reset(scenario);
    this.handlers = [
      this.gate(),
      http.get('*/api/status', () => HttpResponse.json(this.nextStatus())),
      http.get('*/api/settings', () => HttpResponse.json(this.config)),
      http.get('*/api/audio-profiles', () => HttpResponse.json(this.profiles)),
      // Like the firmware, browse only from the home network.
      http.get('*/api/bridges', () =>
        this.status.mode === 'provisioned'
          ? HttpResponse.json({ bridges: this.bridges })
          : reject(503, 'bridge discovery needs the home network'),
      ),
      http.get('*/api/logs', () => HttpResponse.json(this.nextLogs())),
      http.get('*/api/coredump/image', () =>
        this.coredump
          ? new HttpResponse(this.coredump, {
              headers: { 'Content-Type': 'application/octet-stream' },
            })
          : reject(404, 'no crash dump is stored'),
      ),
      getGetCoredumpMockHandler(() => ({
        present: this.coredump !== null,
        size_bytes: this.coredump?.byteLength ?? 0,
      })),
      getGetHealthMockHandler(() => this.status.health),
      getGetBoardsMockHandler(() => this.boards()),
      getGetMetricsMockHandler(() => this.metricsText()),
      getGetOpenapiMockHandler(contract as GetOpenapi200),
      this.write('/api/coredump/erase', null, () => {
        this.coredump = null;
        return { ok: true };
      }),
      this.write('/api/unlock', null, () => ({ ok: true })),
      this.write('/api/settings/wifi', rules.WifiSettingsRequest, (body) => this.join(body)),
      this.write('/api/settings/target', rules.TargetSettingsRequest, (body) => {
        this.config.target_host = body.target_host ?? '';
        this.config.target_port = body.target_port ?? this.config.target_port;
        this.status.target.target_host = this.config.target_host;
        this.status.target.target_port = this.config.target_port;
        // Like the firmware: a boot applies the target, and setup mode keeps it
        // staged for commissioning instead of restarting.
        return this.status.mode === 'setup' ? { ok: true } : { ok: true, rebooting: true };
      }),
      this.write('/api/settings/name', rules.NameSettingsRequest, (body) => {
        this.config.device_name = body.name ?? '';
        this.status.device_name = this.config.device_name;
        return { ok: true };
      }),
      this.write('/api/settings/audio', rules.AudioSettingsRequest, (audio) => {
        Object.assign(this.config, audio);
        Object.assign(this.status.audio, audio);
        // Like the firmware: levels set by hand are no profile's.
        this.profiles.active_profile_id = null;
        return this.levelsApplied();
      }),
      this.write(
        '/api/settings/analog-passthrough',
        rules.AnalogPassthroughSettingsRequest,
        ({ enabled }) => {
          this.config.analog_passthrough_enabled = enabled;
          this.status.analog_passthrough.enabled = enabled;
          // Setup mode runs no codec, so the route waits for commissioning.
          this.status.analog_passthrough.active = enabled && this.status.mode !== 'setup';
          return { ok: true };
        },
      ),
      this.write('/api/settings/led', rules.LedSettingsRequest, (body) => {
        const led = this.config.led_roles.find((role) => role.id === body.id);
        if (!led) return reject(400, 'This board has no such LED.', 'id');
        led.role = body.role;
        return { ok: true };
      }),
      this.write('/api/settings/button', rules.ButtonSettingsRequest, (body) => {
        const button = this.config.button_actions.find((entry) => entry.id === body.id);
        if (!button) return reject(400, 'This board has no such button.', 'id');
        button.action = body.action;
        return { ok: true };
      }),
      this.write('/api/stream', rules.StreamRequest, ({ enabled }) => {
        this.status.stream.enabled = enabled;
        return { ok: true };
      }),
      this.write('/api/settings/board', rules.BoardSettingsRequest, (body) =>
        this.selectBoard(body),
      ),
      this.write('/api/settings/audio-profiles', rules.AudioProfilesSettingsRequest, (body) =>
        this.replaceProfiles(body.catalog),
      ),
      this.write('/api/settings/audio-profile', rules.ActiveAudioProfileRequest, (body) =>
        this.activateProfile(body.profile_id ?? ''),
      ),
      this.write('/api/settings/admin-key', rules.AdminKeySettingsRequest, (body) => {
        this.adminKey = body.admin_key;
        return { ok: true };
      }),
      this.write('/api/settings/firmware', rules.FirmwareSettingsRequest, (body) => {
        this.config.auto_update_schedule = body.auto_update_schedule;
        return { ok: true };
      }),
      this.write('/api/settings/transport', rules.TransportSettingsRequest, ({ mode }) => {
        this.transport().mode = mode;
        this.status.target.transport = mode === 'tls-psk' ? 'tls' : 'tcp';
        return { ok: true };
      }),
      this.write('/api/transport/keys/stage', null, () => this.stageKey()),
      this.write('/api/transport/keys/verify', null, () => {
        if (!this.transport().pending_key_id) return reject(400, 'no staged credential');
        this.transport().pending_verified = true;
        return { ok: true };
      }),
      this.write('/api/transport/keys/activate', null, () => this.activateKey()),
      this.write('/api/transport/keys/discard', null, () => {
        this.transport().pending_key_id = null;
        this.transport().pending_verified = false;
        return { ok: true };
      }),
      this.write('/api/transport/keys/rollback', null, () => {
        const transport = this.transport();
        if (!transport.rollback_key_id) return reject(400, 'no previous credential');
        transport.active_key_id = transport.rollback_key_id;
        transport.rollback_key_id = null;
        return { ok: true };
      }),
      this.write('/api/transport/keys/retire', null, () => {
        this.transport().rollback_key_id = null;
        return { ok: true };
      }),
      this.write('/api/transport/recover', null, () => {
        this.transport().mode = 'cleartext';
        this.status.target.transport = 'tcp';
        return this.stageKey();
      }),
      this.write('/api/ota/update', rules.OtaUpdateRequest, (body) => this.startUpdate(body)),
      this.write('/api/ota/check', null, () => {
        this.status.ota.phase = 'up-to-date';
        this.status.ota.latest_version = this.status.firmware_version;
        this.status.ota.message = `v${this.status.firmware_version} is the latest release`;
        return { ok: true };
      }),
      this.write('/api/ota/rollback', null, () => this.rollbackUpdate()),
      this.write('/api/restart', null, () => ({ ok: true, rebooting: true })),
      // Reset erases the configuration but keeps the setup password: it is
      // device identity, and the response repeats the label credentials.
      this.write('/api/factory-reset', null, () => {
        this.reset('first-boot');
        return { rebooting: true, setup_network: this.setupNetwork };
      }),
      // Any other operation answers as the contract's examples say.
      ...getStreamLineDeviceAPIMock(),
    ];
  }

  private reset(scenario: DeviceScenario): void {
    // A factory reset keeps counting boots, as the firmware's boot id does.
    const boot = this.status ? this.status.system.boot : null;
    if (scenario === 'steady') {
      this.status = deviceStatus({ metrics: { playing: true } });
      this.config = deviceConfig();
      this.adminKey = MOCK_ADMIN_KEY;
      this.wifiPassword = NETWORKS_IN_RANGE[this.config.ssid] ?? '';
    } else if (scenario === 'recovery') {
      // The saved network is out of range, so the device serves recovery.
      this.config = deviceConfig({ ssid: 'Old router' });
      this.wifiPassword = 'old password';
      this.status = deviceStatus({
        mode: 'recovery',
        wifi: {
          ...SETUP_NETWORK_WIFI,
          ssid: this.config.ssid,
          join_failure: 'network-not-found',
        },
        diagnostics: {
          last_fallback:
            'v0.9.0: Wi-Fi station connection failed (network-not-found): Wi-Fi connect failed after 3 attempts',
        },
        metrics: SILENT_METRICS,
      });
      this.adminKey = MOCK_ADMIN_KEY;
    } else {
      this.status = deviceStatus({
        mode: 'setup',
        auth_required: false,
        wifi: { ...SETUP_NETWORK_WIFI, ssid: '' },
        target: { target_host: '' },
        // The contract example streams; an unconfigured device is silent.
        metrics: SILENT_METRICS,
      });
      this.config = deviceConfig({ ssid: '', target_host: '' });
      this.adminKey = null;
    }
    if (boot !== null) this.status.system.boot = boot;
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

  /**
   * In front of every handler: a device away from this browser's network
   * answers nothing, a request that needs the admin key gets the challenge
   * without it, and a write that can restart the device waits for a busy
   * update. A request that passes goes on to its operation's handler.
   */
  private gate(): HttpHandler {
    return http.all('*/api/*', ({ request }) => {
      if (!this.here(request)) return HttpResponse.error();
      const path = new URL(request.url).pathname;
      const denied =
        request.method !== 'GET' || AUTHENTICATED_READS.has(path) ? this.deny(request) : null;
      if (denied) return denied;
      if (this.status.ota.busy && RESTARTING_WRITES.has(path)) {
        return reject(409, 'a firmware update or check is in progress; retry after it finishes');
      }
      return undefined;
    });
  }

  /**
   * Whether the device answers on this browser's network now. A device that
   * left answers nothing; each status read counts down an absence, and the
   * read that ends it is answered by the device as it came back.
   */
  private here(request: Request): boolean {
    if (this.absentReads === 0) return true;
    if (new URL(request.url).pathname !== '/api/status') return false;
    this.absentReads -= 1;
    if (this.absentReads > 0) return false;
    this.onReturn?.();
    this.onReturn = null;
    return true;
  }

  /** Leave this browser's network, for `reads` status reads or for good. */
  private leave(reads: number, onReturn: (() => void) | null = null): void {
    this.absentReads = reads;
    this.onReturn = onReturn;
  }

  /**
   * 401 with a fresh digest challenge, the header shape the firmware sends.
   * Minting invalidates the previous nonce, as the firmware's bounded nonce
   * table eventually does.
   */
  private challenge(): Response {
    this.nonceSerial += 1;
    this.nonce = { value: `mock-nonce-${this.nonceSerial}`, lastNc: 0 };
    return HttpResponse.json(
      { error: 'unauthorized' },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", qop="auth", algorithm=SHA-256, nonce="${this.nonce.value}"`,
        },
      },
    );
  }

  /**
   * The firmware's digest admin check: verify the RFC 7616 response over the
   * live nonce and a strictly increasing count. Null when authorized; an
   * unprovisioned device (no key) accepts everything.
   */
  private deny(request: Request): Response | null {
    if (!this.adminKey) return null;
    const fields = parseDigestFields(request.headers.get('authorization'));
    if (!fields) return this.challenge();
    const url = new URL(request.url);
    const uri = url.pathname + url.search;
    const nc = fields.get('nc') ?? '';
    const count = Number.parseInt(nc, 16);
    if (
      fields.get('username') !== DIGEST_USERNAME ||
      fields.get('realm') !== DIGEST_REALM ||
      fields.get('uri') !== uri ||
      !this.nonce ||
      fields.get('nonce') !== this.nonce.value ||
      !Number.isFinite(count) ||
      count <= this.nonce.lastNc
    ) {
      return this.challenge();
    }
    const expected = digestResponse(
      DIGEST_USERNAME,
      DIGEST_REALM,
      this.adminKey,
      request.method,
      uri,
      this.nonce.value,
      nc,
      fields.get('cnonce') ?? '',
    );
    if (fields.get('response') !== expected) return this.challenge();
    this.nonce.lastNc = count;
    return null;
  }

  /**
   * POST: the body decoded into the types its rule names and checked against
   * it, as the firmware refuses a request that breaks the contract, then
   * applied. The result may be an error `HttpResponse`.
   */
  private write<T>(
    path: string,
    rule: RequestRule<T> | null,
    apply: (body: T) => JsonBodyType | Response,
  ): HttpHandler {
    return http.post(`*${path}`, async ({ request }) => {
      let body = undefined as T;
      if (rule) {
        const form = await request.formData().catch(() => new FormData());
        const checked = v.safeParse(rule, formFields(rule, form));
        if (!checked.success) {
          const [issue] = checked.issues;
          const field = issue.path?.[0]?.key;
          return reject(400, issue.message, typeof field === 'string' ? field : null);
        }
        body = checked.output;
      }
      const result = apply(body);
      if (result instanceof Response) return result;
      if ((result as { rebooting?: boolean } | null)?.rebooting) this.boot();
      return HttpResponse.json(result);
    });
  }

  /** A restarting write: silent while it restarts, unless a join already took it away. */
  private boot(): void {
    if (this.absentReads === 0) this.leave(RESTART_READS);
    this.restart();
  }

  /**
   * A new boot: a new boot id, uptime from zero, streaming resumed, and the
   * log of the boot that ended kept as the previous one.
   */
  private restart(): void {
    this.previousBootLog = this.currentLog();
    this.status.system.boot += 1;
    this.status.system.uptime_seconds = 0;
    this.status.stream.enabled = true;
    this.startLog();
  }

  /** One status poll: audio moves while playing, and pending OTA phases advance. */
  private nextStatus(): StatusResponse {
    const metrics = this.status.metrics;
    metrics.sequence += 100;
    if (
      this.status.stream.enabled &&
      this.config.target_host &&
      this.status.mode === 'provisioned'
    ) {
      metrics.packets_total += 100;
      if (metrics.playing) metrics.bytes_total += 102400;
      else metrics.silence_packets_total += 100;
    }
    if (metrics.playing) {
      const peak = PEAK_STEPS[this.poll % PEAK_STEPS.length];
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
   * First contact, a recovery change and a change from the home network share
   * this write: save Wi-Fi, adopt a supplied admin key, restart and join. A
   * join that works takes the device off a setup network for good; one that
   * fails brings it back there, after a restart and three attempts, with the
   * cause. From the home network, only a new password for the same network
   * brings it back to this browser.
   */
  private join(body: v.InferOutput<typeof rules.WifiSettingsRequest>): JsonBodyType | Response {
    const ssid = body.ssid.trim();
    if (!ssid) return reject(400, 'A network name is required.', 'ssid');
    // Like the firmware: only `open_network` makes a network open, and a blank
    // password keeps a stored one, which a saved open network does not have.
    const open = body.open_network;
    if (open && body.password) {
      return reject(400, 'An open network has no password.', 'password');
    }
    const storedPassword = this.config.ssid !== '' && !this.config.open_network;
    if (!open && !body.password && !storedPassword) {
      return reject(
        400,
        'A protected network needs its password; the device stores none.',
        'password',
      );
    }
    if (body.admin_key) this.adminKey = body.admin_key;
    const fromHome = this.status.mode === 'provisioned';
    const sameNetwork = ssid === this.config.ssid;
    this.wifiPassword = open ? '' : body.password || this.wifiPassword;
    this.config.ssid = ssid;
    this.config.open_network = open;
    // An absent target keeps the stored one; an empty host clears it.
    if (body.target_host !== undefined && body.target_host !== null) {
      this.config.target_host = body.target_host;
      this.config.target_port = body.target_port ?? this.config.target_port;
      this.status.target.target_host = this.config.target_host;
      this.status.target.target_port = this.config.target_port;
    }
    this.status.auth_required = this.adminKey !== null;
    const failure = this.joinFailure(ssid, open);
    if (failure) {
      if (fromHome) this.leave(Number.POSITIVE_INFINITY);
      else this.leave(JOIN_ATTEMPT_READS, () => this.recover(failure));
    } else if (fromHome && sameNetwork) {
      this.joined();
    } else {
      this.leave(Number.POSITIVE_INFINITY);
    }
    return { ok: true, rebooting: true };
  }

  /** Why joining `ssid` fails from here, or null when it works. */
  private joinFailure(ssid: string, open: boolean): JoinFailure | null {
    if (!(ssid in NETWORKS_IN_RANGE)) return 'network-not-found';
    const password = NETWORKS_IN_RANGE[ssid];
    if ((password === null) !== open) return 'security-mismatch';
    if (password !== null && this.wifiPassword !== password) return 'credentials-rejected';
    return null;
  }

  private joined(): void {
    this.status.mode = 'provisioned';
    Object.assign(this.status.wifi, {
      ssid: this.config.ssid,
      status: 'connected',
      sta_ip: '192.0.2.10',
      ap_ip: '',
      rssi_dbm: -55,
      join_failure: null,
    });
  }

  /** Back on the setup network beside a station that keeps retrying the saved one. */
  private recover(failure: JoinFailure): void {
    this.status.mode = 'recovery';
    Object.assign(this.status.wifi, {
      ...SETUP_NETWORK_WIFI,
      ssid: this.config.ssid,
      join_failure: failure,
    });
    Object.assign(this.status.metrics, SILENT_METRICS);
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

  private boards(): BoardCatalogResponse {
    return {
      boards: [this.status.capabilities],
      selected_board: this.status.capabilities,
      selected_board_id: this.status.capabilities.board_id,
    };
  }

  private selectBoard(
    body: v.InferOutput<typeof rules.BoardSettingsRequest>,
  ): JsonBodyType | Response {
    if (body.board_id && body.board_id !== this.status.capabilities.board_id) {
      return reject(400, `unknown board descriptor '${body.board_id}'`, 'board_id');
    }
    if (body.descriptor) {
      try {
        JSON.parse(body.descriptor);
      } catch {
        return reject(400, 'invalid board descriptor: not valid JSON', 'descriptor');
      }
    }
    return { ok: true, rebooting: true };
  }

  /**
   * Like the firmware: a catalog that breaks the contract's rule or names
   * another board is refused, the file's active profile is ignored, and the
   * one in use stays while the catalog keeps it.
   */
  private replaceProfiles(text: string | undefined): JsonBodyType | Response {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text ?? '');
    } catch {
      return reject(400, 'This is not a profile catalog: not valid JSON.', 'catalog');
    }
    const checked = v.safeParse(rules.AudioProfileCatalog, parsed);
    if (!checked.success) {
      return reject(400, `This is not a profile catalog: ${checked.issues[0].message}.`, 'catalog');
    }
    const catalog: AudioProfileCatalog = checked.output;
    if (catalog.board_id !== this.status.capabilities.board_id) {
      return reject(400, 'These profiles are for another board.', 'catalog');
    }
    const active = this.profiles.active_profile_id;
    this.profiles = {
      ...catalog,
      active_profile_id: catalog.profiles.some((profile) => profile.id === active) ? active : null,
    };
    return { ok: true };
  }

  private activateProfile(profileId: string): JsonBodyType | Response {
    if (profileId && !this.profiles.profiles.some((profile) => profile.id === profileId)) {
      return reject(400, 'No profile has that id.', 'profile_id');
    }
    this.profiles.active_profile_id = profileId || null;
    const profile = this.profiles.profiles.find((entry) => entry.id === profileId);
    if (profile) Object.assign(this.status.audio, profile.audio);
    return this.levelsApplied();
  }

  /**
   * Like the firmware: a running codec takes new levels at once, the setup
   * network keeps them for commissioning, and any other device restarts.
   */
  private levelsApplied(): JsonBodyType {
    const codecRuns =
      this.status.mode === 'provisioned' && this.status.health.status !== 'blocking';
    return codecRuns || this.status.mode === 'setup' ? { ok: true } : { ok: true, rebooting: true };
  }

  /**
   * Play the install out over the next status polls, ending on the new image.
   * Like the firmware, an empty request installs the latest release, and a
   * custom image needs its URL and digest together.
   */
  private startUpdate(body: v.InferOutput<typeof rules.OtaUpdateRequest>): JsonBodyType | Response {
    if (Boolean(body.url) !== Boolean(body.sha256)) {
      return reject(400, 'url and sha256 must be provided together');
    }
    const ota = this.status.ota;
    const from = this.status.firmware_version;
    const release = ota.latest_version && ota.latest_version !== from ? ota.latest_version : '';
    const target = !body.url && release ? release : MOCK_UPDATED_VERSION;
    ota.busy = true;
    ota.bytes_total = 1500000;
    ota.bytes_written = 0;
    ota.phase = 'downloading';
    ota.message = 'audio paused while the update installs';
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
        // The device restarts into the new image and answers from it.
        this.leave(RESTART_READS, () => {
          this.restart();
          this.status.firmware_version = target;
          ota.last_result = 'installed';
          ota.busy = false;
          ota.phase = 'idle';
          ota.message = '';
          ota.rollback_available = true;
          ota.rollback_version = from;
        });
      },
    ];
    return { ok: true, started: true };
  }

  private rollbackUpdate(): JsonBodyType | Response {
    const ota = this.status.ota;
    if (!ota.rollback_available) return reject(400, 'no previous image to roll back to');
    this.status.firmware_version = ota.rollback_version;
    ota.last_result = 'rolled-back';
    ota.rollback_available = false;
    ota.rollback_version = '';
    return { ok: true, rebooting: true };
  }

  /**
   * Start this boot's log. A provisioned device has restarted at least once,
   * so it can show the boot before this one; a first-boot device cannot.
   */
  private resetLog(scenario: DeviceScenario): void {
    this.startLog();
    this.previousBootLog =
      scenario === 'steady'
        ? {
            boot: this.status.system.boot - 1,
            first_sequence: 12,
            dropped: 12,
            text: [...this.logLines.map((line) => line.text), ...PREVIOUS_BOOT_TAIL]
              .map((line) => `${line}\n`)
              .join(''),
          }
        : null;
  }

  private startLog(): void {
    this.logLines = [];
    this.logSequence = 0;
    this.logDropped = 0;
    for (const text of BOOT_LOG) this.appendLog(text);
  }

  /** This boot's log as the device reports it. */
  private currentLog(): BootLog {
    return {
      boot: this.status.system.boot,
      first_sequence: this.logSequence - this.logLines.length,
      dropped: this.logDropped,
      text: this.logLines.map((line) => `${line.text}\n`).join(''),
    };
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
        ? `stream: sent ${this.status.metrics.packets_total} packets`
        : 'capture: input silent, stream paused',
    );
    return { current: this.currentLog(), previous: this.previousBootLog };
  }

  private metricsText(): string {
    const metrics = this.status.metrics;
    return [
      `streamline_stream_packets_total ${metrics.packets_total}`,
      `streamline_stream_bytes_total ${metrics.bytes_total}`,
      `streamline_playing ${metrics.playing ? 1 : 0}`,
      '',
    ].join('\n');
  }
}

/**
 * A form body's fields as the types `rule` names them: the generated client
 * sends every value as text.
 */
function formFields(rule: { entries: Record<string, unknown> }, form: FormData) {
  return Object.fromEntries(
    [...form.entries()].map(([name, value]) => {
      let schema = rule.entries[name] as { type?: string; wrapped?: unknown } | undefined;
      while (schema && 'wrapped' in schema) schema = schema.wrapped as typeof schema;
      const text = String(value);
      return [
        name,
        schema?.type === 'number'
          ? Number(text)
          : schema?.type === 'boolean'
            ? text === 'true'
            : text,
      ];
    }),
  );
}

/** A refusal shaped like the device's: its reason, and the request field it names. */
function reject(status: number, message: string, field: string | null = null): Response {
  return HttpResponse.json({ error: message, field }, { status });
}
