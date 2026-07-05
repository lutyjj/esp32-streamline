import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';
import type { components } from './generated/openapi';

export type OpenApiDocument = components['schemas']['OpenApiDocument'];
export type DeviceStatus = components['schemas']['DeviceStatus'];
export type OtaSnapshot = components['schemas']['OtaSnapshot'];
export type DeviceConfig = components['schemas']['DeviceConfig'];

/** Mutation acknowledgement; `rebooting` marks writes that restart the device. */
export type Ack = components['schemas']['Ack'];

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
    throw new Error('unauthorized — unlock settings with the admin key');
  }
  if (!r.ok) throw new Error(String(data.error || text || r.status));
  return data as T;
}

export const getStatus = () => api<DeviceStatus>('/api/status');

export const getSettings = () => api<DeviceConfig>('/api/settings');

export const getOpenApi = () => api<OpenApiDocument>('/api/openapi.json');

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
