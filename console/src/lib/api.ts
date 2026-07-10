import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from '../generated/api';
import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';

export type BoardCapabilities = components['schemas']['CapabilitiesStatus'];
export type BoardCatalog = components['schemas']['BoardCatalogResponse'];
export type BoardDescriptor = components['schemas']['Board'];
export type DeviceStatus = components['schemas']['StatusResponse'];
export type DeviceConfig = components['schemas']['ConfigResponse'];
export type HealthCheck = components['schemas']['HealthCheck'];
export type HealthReport = components['schemas']['HealthReport'];
export type HealthSeverity = components['schemas']['Severity'];
export type HealthCheckStatus = components['schemas']['CheckStatus'];
export type OtaSnapshot = components['schemas']['OtaStatus'];
export type AudioProfile = components['schemas']['AudioProfile'];
export type AudioProfileSettings = components['schemas']['AudioSettings'];
export type AudioProfileCatalog = components['schemas']['AudioProfileCatalog'];
export type Ack = components['schemas']['Ack'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (request: Request) => Promise<Response>;

let transport: FetchLike = (request) => fetch(request);

const auth: Middleware = {
  onRequest({ request }) {
    if (request.method === 'GET') return;
    const key = storedAdminKey();
    if (key && isUnlocked()) request.headers.set('Authorization', `Bearer ${key}`);
  },
  onResponse({ response }) {
    if (response.status === 401) lockSettings();
  },
};

function makeClient() {
  const next = createClient<paths>({
    fetch: transport,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  next.use(auth);
  return next;
}

export let apiClient = makeClient();

export function setTransport(next: FetchLike): void {
  transport = next;
  apiClient = makeClient();
}

type ApiResult<T, E> =
  | { data: T; error?: never; response: Response }
  | { data?: never; error: E; response: Response };

/** Convert the generated client's result union into the console's promise contract. */
export async function unwrap<T, E>(request: Promise<ApiResult<T, E>>): Promise<NonNullable<T>> {
  const result = await request;
  if (result.data !== undefined) return result.data as NonNullable<T>;
  const error = result.error as { error?: string } | string | undefined;
  const message =
    typeof error === 'string'
      ? error
      : error?.error || (await result.response.text()) || String(result.response.status);
  if (result.response.status === 401) {
    throw new ApiError(401, 'unauthorized — unlock settings with the admin key');
  }
  throw new ApiError(result.response.status, message);
}

export const getStatus = () => unwrap(apiClient.GET('/api/status'));

export const getSettings = () => unwrap(apiClient.GET('/api/settings'));

export const getAudioProfiles = () => unwrap(apiClient.GET('/api/audio-profiles'));

export const setAudioProfiles = (catalog: AudioProfileCatalog) =>
  unwrap(
    apiClient.POST('/api/settings/audio-profiles', { body: { catalog: JSON.stringify(catalog) } }),
  );

export const setActiveAudioProfile = (profile_id: string) =>
  unwrap(apiClient.POST('/api/settings/audio-profile', { body: { profile_id } }));

export const getBoards = () => unwrap(apiClient.GET('/api/boards'));

export const setBoard = (board_id: string) =>
  unwrap(apiClient.POST('/api/settings/board', { body: { board_id } }));

export const setCustomBoard = (descriptor: BoardDescriptor) =>
  unwrap(
    apiClient.POST('/api/settings/board', { body: { descriptor: JSON.stringify(descriptor) } }),
  );

/** Ask the device whether it accepts `key`; this intentionally bypasses stored auth state. */
export async function verifyAdminKey(key: string): Promise<boolean> {
  const response = await transport(
    new Request('/api/unlock', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    }),
  );
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`unlock failed: HTTP ${response.status}`);
  return true;
}
