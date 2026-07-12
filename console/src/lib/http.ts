import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';

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

export function setTransport(next: FetchLike): void {
  transport = next;
}

export async function deviceFetch<T>(url: string, options: RequestInit): Promise<T> {
  const request = new Request(url, options);
  if (request.method !== 'GET') {
    const key = storedAdminKey();
    if (key && isUnlocked()) request.headers.set('Authorization', `Bearer ${key}`);
  }

  const response = await transport(request);
  if (response.status === 401) lockSettings();

  const text = await response.text();
  if (!response.ok) {
    const error = parseBody(text) as { error?: string } | string | undefined;
    const message =
      response.status === 401
        ? 'unauthorized — unlock settings with the admin key'
        : typeof error === 'string'
          ? error
          : error?.error || text || String(response.status);
    throw new ApiError(response.status, message);
  }

  return parseBody(text) as T;
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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
