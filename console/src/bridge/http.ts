import { sessionStore } from '../lib/custody';
import { ApiError, type FetchLike } from '../lib/http';

const TOKEN_KEY = 'streamline.bridgeToken';

let transport: FetchLike = (request) => fetch(request);

export function setBridgeTransport(next: FetchLike): void {
  transport = next;
}

export function bridgeToken(): string {
  return sessionStore.get(TOKEN_KEY) || '';
}

// The token is a shared deployment secret, so it never persists past the tab —
// unlike the per-device admin key. See docs/security.md ("no persistent token
// storage").
export function rememberBridgeToken(token: string): void {
  sessionStore.set(TOKEN_KEY, token);
}

export function forgetBridgeToken(): void {
  sessionStore.remove(TOKEN_KEY);
}

export function bridgeBase(): string {
  const raw = document.querySelector<HTMLMetaElement>('meta[name="ingress-base"]')?.content || '';
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(raw) ? raw : '';
}

/**
 * Authorization is the generated contract's, not inferred from path shapes:
 * every operation declaring `security` in docs/bridge-openapi.json, as
 * "METHOD /path/template". The parity test walks the artifact and fails on
 * any drift, so a new operation cannot ship unclassified.
 */
export const SECURED_OPERATIONS = [
  'GET /api/recordings',
  'POST /api/recordings',
  'DELETE /api/recordings/{recording_id}',
  'POST /api/recordings/{recording_id}/download-ticket',
  'GET /api/recordings/{recording_id}/file',
  'POST /api/recordings/{recording_id}/stop',
  'PUT /api/transport/keys/{key_id}',
  'DELETE /api/transport/keys/{key_id}',
  'PUT /api/transport/mode',
  'POST /api/unlock',
] as const;

export function operationSecured(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return SECURED_OPERATIONS.some((entry) => {
    const [entryMethod, template] = entry.split(' ');
    if (entryMethod !== upper) return false;
    const pattern = new RegExp(`^${template.replaceAll(/\{[^}]+\}/g, '[^/]+')}$`);
    return pattern.test(path);
  });
}

/**
 * An authenticated request the bridge rejected is one lock transition, owned
 * here so every surface behaves the same: the token is forgotten and the
 * registered handler drops private state. 400/409 stay ordinary errors.
 */
let onAuthRejected: () => void = () => {};

export function setAuthRejectedHandler(next: () => void): void {
  onAuthRejected = next;
}

export async function bridgeFetch<T>(path: string, options: RequestInit): Promise<T> {
  const request = new Request(`${bridgeBase()}${path}`, options);
  const secured = operationSecured(options.method ?? 'GET', path);
  if (secured) {
    const token = bridgeToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await transport(request);
  const text = await response.text();
  const body = parseBody(text);
  if (!response.ok) {
    if (response.status === 401 && secured) {
      forgetBridgeToken();
      onAuthRejected();
    }
    const detail = body as { error?: { message?: string } } | undefined;
    throw new ApiError(response.status, detail?.error?.message || text || String(response.status));
  }
  return body as T;
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
