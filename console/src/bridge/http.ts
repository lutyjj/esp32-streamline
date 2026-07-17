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

/** Every mutating bridge route; reads stay open per docs/security.md. */
function requiresToken(path: string): boolean {
  if (path === '/api/unlock' || path === '/api/transport/mode') return true;
  if (path.startsWith('/api/transport/keys/')) return true;
  return path.startsWith('/api/recordings') && !path.includes('/capabilities');
}

export async function bridgeFetch<T>(path: string, options: RequestInit): Promise<T> {
  const request = new Request(`${bridgeBase()}${path}`, options);
  if (requiresToken(path)) {
    const token = bridgeToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await transport(request);
  const text = await response.text();
  const body = parseBody(text);
  if (!response.ok) {
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
