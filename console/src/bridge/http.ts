import { ApiError, type FetchLike } from '../lib/http';

const TOKEN_KEY = 'streamline.recordingToken';

let transport: FetchLike = (request) => fetch(request);

export function setBridgeTransport(next: FetchLike): void {
  transport = next;
}

export function recordingToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function rememberRecordingToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function forgetRecordingToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function bridgeBase(): string {
  const raw = document.querySelector<HTMLMetaElement>('meta[name="ingress-base"]')?.content || '';
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(raw) ? raw : '';
}

export async function bridgeFetch<T>(path: string, options: RequestInit): Promise<T> {
  const request = new Request(`${bridgeBase()}${path}`, options);
  if (path.startsWith('/api/recordings') && !path.includes('/capabilities')) {
    const token = recordingToken();
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
