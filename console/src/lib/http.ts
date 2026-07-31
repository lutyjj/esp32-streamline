import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';
import { DigestSession, parseChallenge } from './digest';

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

/** The accepted challenge writes reuse; dropped when the device stops accepting it. */
let session: DigestSession | null = null;

export function setTransport(next: FetchLike): void {
  transport = next;
  session = null;
}

/**
 * Reads the device gates behind the admin key. Every other read is open, and
 * staying open matters: the status poll runs every couple of seconds and
 * should not spend digest round trips.
 *
 * `tests/api.test.ts` pins this list to the operations `docs/openapi.json`
 * declares `digest_auth` on, so a new authenticated read cannot forget it.
 */
export const AUTHENTICATED_READS: ReadonlySet<string> = new Set([
  '/api/logs',
  '/api/coredump',
  '/api/coredump/image',
]);

function needsAdminKey(request: Request): boolean {
  return request.method !== 'GET' || AUTHENTICATED_READS.has(new URL(request.url).pathname);
}

/**
 * Send a request that needs the admin key, answering the device's digest
 * challenge. With a live session the request costs one round trip; a 401
 * fetches a fresh challenge and retries once, so an expired nonce never
 * surfaces as a failure.
 */
async function authorizedExchange(request: Request, key: string): Promise<Response> {
  const retry = request.clone();
  const url = new URL(request.url);
  const uri = url.pathname + url.search;
  if (session) {
    request.headers.set('Authorization', session.authorization(key, request.method, uri));
  }
  const response = await transport(request);
  if (response.status !== 401) return response;
  const challenge = parseChallenge(response.headers.get('WWW-Authenticate'));
  if (!challenge) return response;
  session = new DigestSession(challenge);
  retry.headers.set('Authorization', session.authorization(key, retry.method, uri));
  const answered = await transport(retry);
  if (answered.status === 401) session = null;
  return answered;
}

export async function deviceFetch<T>(url: string, options: RequestInit): Promise<T> {
  const request = new Request(url, options);
  const key = needsAdminKey(request) && isUnlocked() ? storedAdminKey() : '';

  const response = key ? await authorizedExchange(request, key) : await transport(request);
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
  const attempt = (authorization?: string) => {
    const request = new Request('/api/unlock', { method: 'POST' });
    if (authorization) request.headers.set('Authorization', authorization);
    return transport(request);
  };
  const challenged = await attempt();
  // An unprovisioned device has no key yet and accepts the check outright.
  if (challenged.ok) return true;
  if (challenged.status !== 401) throw new Error(`unlock failed: HTTP ${challenged.status}`);
  const challenge = parseChallenge(challenged.headers.get('WWW-Authenticate'));
  if (!challenge) return false;
  const answered = await attempt(
    new DigestSession(challenge).authorization(key, 'POST', '/api/unlock'),
  );
  if (answered.status === 401) return false;
  if (!answered.ok) throw new Error(`unlock failed: HTTP ${answered.status}`);
  return true;
}
