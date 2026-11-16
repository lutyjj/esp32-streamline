import type { ErrorResponse } from '../../generated/api';
import { AUTHENTICATED_READS } from '../../generated/facts';
import { ApiError, type FetchLike } from '../../shared/http';
import { isUnlocked, lockSettings, storedAdminKey } from './adminKey';
import { DigestSession, parseChallenge } from './digest';

let transport: FetchLike = (request) => fetch(request);

/**
 * How long a request waits for the device when its caller sets no bound of
 * its own. The device's slowest answer, a bridge search, takes three seconds.
 */
export const ANSWER_WITHIN_MS = 10_000;

/**
 * The console answers the device's digest challenge itself, so its requests
 * must not carry browser-managed credentials. A same-origin request that does
 * would make the browser prompt for a username and password on the 401
 * (Fetch, HTTP-network-or-cache fetch: a 401 prompts only when
 * `includeCredentials` is true), interrupting the unlock flow with a native
 * dialog the console cannot style, explain, or dismiss.
 */
function deviceRequest(url: string, options: RequestInit = {}): Request {
  return new Request(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(ANSWER_WITHIN_MS),
    credentials: 'omit',
  });
}

/** An exchange the device left unanswered past its bound fails in words a person can act on. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('the device did not answer in time');
    }
    throw error;
  }
}

/** The accepted challenge writes reuse; dropped when the device stops accepting it. */
let session: DigestSession | null = null;

/** Runs each exchange once the one before it has ended, in the order they came. */
function oneAtATime(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (work) => {
    const turn = last.then(work, work);
    last = turn.catch(() => undefined);
    return turn;
  };
}

/**
 * The device's server keeps four sockets and closes the least recently used
 * when another arrives. The console holds at most two of them: status reads
 * take one lane and every other request the other, so the poll that tells
 * whether the device answers never waits behind the console's own queue.
 */
let lanes = { status: oneAtATime(), other: oneAtATime() };

function laneOf(url: string) {
  return new URL(url, 'http://device.invalid').pathname === '/api/status'
    ? lanes.status
    : lanes.other;
}

export function setTransport(next: FetchLike): void {
  transport = next;
  session = null;
  lanes = { status: oneAtATime(), other: oneAtATime() };
}

/**
 * Writes and the reads the contract gates carry the key. Every other read
 * stays open, so the status poll spends no digest round trips.
 */
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

export function deviceFetch<T>(url: string, options: RequestInit): Promise<T> {
  // The request, and with it its bound, starts when its lane is free.
  return bounded(laneOf(url)(() => exchange<T>(deviceRequest(url, options))));
}

async function exchange<T>(request: Request): Promise<T> {
  // A caller that gave up while its request waited for the lane sends nothing.
  request.signal.throwIfAborted();
  const key = needsAdminKey(request) && isUnlocked() ? storedAdminKey() : '';

  const response = key ? await authorizedExchange(request, key) : await transport(request);
  if (response.status === 401) lockSettings();

  const text = await response.text();
  if (!response.ok) {
    const error = parseBody(text) as Partial<ErrorResponse> | string | undefined;
    const message =
      response.status === 401
        ? 'unauthorized — unlock settings with the admin key'
        : typeof error === 'string'
          ? error
          : error?.error || text || String(response.status);
    throw new ApiError(
      response.status,
      message,
      typeof error === 'object' && error !== null ? (error.field ?? null) : null,
    );
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
export function verifyAdminKey(key: string): Promise<boolean> {
  return bounded(lanes.other(() => checkKey(key)));
}

async function checkKey(key: string): Promise<boolean> {
  const attempt = (authorization?: string) => {
    const request = deviceRequest('/api/unlock', { method: 'POST' });
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
