/**
 * Typed client for the device HTTP API.
 *
 * Every shape here mirrors a serde struct in
 * `firmware/streamline/src/adapters/http.rs` — change one, change the other
 * in the same PR.
 */

import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';

/** Mirrors `CapabilitiesStatus`. */
export interface BoardCapabilities {
  board_id: string;
  board: string;
  codec: { driver: string; i2c_address: number };
  pins: {
    i2c: { sda: number; scl: number };
    i2s: { mclk: number; bclk: number; ws: number; din: number };
  };
  input_lines: { line: number; label: string }[];
  input_gain_max: number;
  adc_atten_max_db: number;
}

/** Mirrors `BoardCatalogResponse`. */
export interface BoardCatalog {
  selected_board_id: string;
  selected_board: BoardCapabilities;
  boards: BoardCapabilities[];
}

/** Mirrors `board::Board`. */
export interface BoardDescriptor {
  id: string;
  name: string;
  codec: { driver: string; i2c_address: number };
  pins: {
    i2c: { sda: number; scl: number };
    i2s: { mclk: number; bclk: number; ws: number; din: number };
  };
  input_lines: { line: number; label: string }[];
  input_gain_max: number;
  adc_atten_max_db: number;
}

/** Mirrors `StatusResponse`. */
export interface DeviceStatus {
  firmware_version: string;
  /** Friendly name; empty when unnamed. */
  device_name: string;
  /** The boot contract: "setup" (own AP) or "provisioned" (home network). */
  mode: 'setup' | 'provisioned';
  config_source: string;
  web_server: boolean;
  configuration_writable: boolean;
  auth_required: boolean;
  /** The resolved board's facts, which the audio controls render from. */
  capabilities: BoardCapabilities;
  wifi: {
    hostname: string;
    ssid: string;
    status: string;
    sta_ip: string;
    ap_ip: string;
    rssi: number;
  };
  target: {
    target_host: string;
    target_port: number;
    transport: string;
  };
  audio: {
    input_line: number;
    input_gain: number;
    adc_atten_db: number;
    sample_rate: number;
    channels: number;
    bits_per_sample: number;
  };
  metrics: {
    sequence: number;
    packets: number;
    bytes: number;
    read_errors: number;
    short_reads: number;
    queue_depth: number;
    queue_drops_total: number;
    network_errors_total: number;
    reconnects_total: number;
    clip_threshold_abs: number;
    peak_abs_left: number;
    peak_abs_right: number;
    rms_left: number;
    rms_right: number;
    noise_floor: number;
    clipped_samples_total: number;
    playing: boolean;
  };
  diagnostics: {
    reset_reason: string;
    last_fallback: string;
    last_ota: string;
  };
  ota: OtaSnapshot;
  /** The startup health verdict. */
  health: HealthReport;
}

/** How much a health check's outcome matters; overall is the worst across checks. */
export type HealthSeverity = 'ok' | 'info' | 'blocking';

/** A health check's own outcome, independent of how much it matters. */
export type HealthCheckStatus = 'ok' | 'warn' | 'fail';

/** Mirrors `HealthCheck`. */
export interface HealthCheck {
  /** Stable machine id, e.g. `"codec"`. */
  id: string;
  status: HealthCheckStatus;
  severity: HealthSeverity;
  detail: string;
  remedy: string | null;
  fixable: boolean;
}

/** Mirrors `HealthReport`. */
export interface HealthReport {
  status: HealthSeverity;
  checks: HealthCheck[];
}

/** Mirrors `OtaStatus`. */
export interface OtaSnapshot {
  phase: string;
  bytes_written: number;
  bytes_total: number;
  latest_version: string;
  message: string;
  busy: boolean;
}

/** Mirrors `ConfigResponse`. */
export interface DeviceConfig {
  device_name: string;
  ssid: string;
  target_host: string;
  target_port: number;
  input_line: number;
  input_gain: number;
  adc_atten_db: number;
  config_source: string;
}

/** Mutation acknowledgement; `rebooting` marks writes that restart the device. */
export interface Ack {
  ok?: boolean;
  rebooting?: boolean;
  started?: boolean;
}

/**
 * An HTTP error *response* from the device: a status arrived and it was not ok.
 * Distinct from a transport failure, where `fetch` rejects before any response
 * arrives (offline, or the device dropped the connection mid-reboot). Callers
 * that must tell "the device rejected this" apart from "the connection went
 * away" branch on `instanceof ApiError`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Injectable transport so tests run without a browser network stack. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let transport: FetchLike = (input, init) => fetch(input, init);

export function setTransport(next: FetchLike): void {
  transport = next;
}

/**
 * Fetch a JSON API endpoint, attaching the admin key to mutating requests
 * while the settings are unlocked. A 401 closes the unlock window so the UI
 * relocks everywhere at once.
 */
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  const key = storedAdminKey();
  if (method !== 'GET' && key && isUnlocked()) headers.Authorization = `Bearer ${key}`;
  const r = await transport(path, { ...opts, headers });
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (r.status === 401) {
    lockSettings();
    throw new ApiError(401, 'unauthorized — unlock settings with the admin key');
  }
  if (!r.ok) throw new ApiError(r.status, String(data.error || text || r.status));
  return data as T;
}

export const getStatus = () => api<DeviceStatus>('/api/status');

export const getSettings = () => api<DeviceConfig>('/api/settings');

export const getBoards = () => api<BoardCatalog>('/api/boards');

export const setBoard = (board_id: string) => postForm('/api/settings/board', { board_id });

export const setCustomBoard = (descriptor: BoardDescriptor) =>
  postForm('/api/settings/board', { descriptor: JSON.stringify(descriptor) });

export function postForm<T = Ack>(path: string, fields: Record<string, string>): Promise<T> {
  return api<T>(path, { method: 'POST', body: new URLSearchParams(fields) });
}

/** Ask the device whether it accepts `key`; throws when it cannot answer. */
export async function verifyAdminKey(key: string): Promise<boolean> {
  const r = await transport('/api/unlock', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.status === 401) return false;
  if (!r.ok) throw new Error(`unlock failed: HTTP ${r.status}`);
  return true;
}
