/**
 * The bridge console's transport. Every request goes to the bridge that
 * served the page, by an address relative to it, so a path prefix in front
 * of the bridge keeps working. It carries the token where the contract gates
 * the operation, gives up past its bound, and reports a refusal with the
 * field the bridge names.
 */

import type { ErrorResponse } from '../../generated/bridge';
import { TOKEN_READS } from '../../generated/bridgeFacts';
import { ApiError, bounded, type FetchLike } from '../../shared/http';
import { forgetBridgeToken, heldToken } from './token';

let transport: FetchLike = (request) => fetch(request);

export function setTransport(next: FetchLike): void {
  transport = next;
}

/** A status read unanswered this long leaves the live readings unavailable. */
export const STATUS_WITHIN_MS = 5_000;
/** Any other request waits past the bridge's own longest wait, a Sendspin call's ten seconds. */
export const ANSWER_WITHIN_MS = 30_000;

/** `url` as the contract names its operation, whatever prefix the page sits under. */
function operationPath(url: string): string {
  return new URL(url, 'http://bridge.invalid/').pathname;
}

/** The contract's gated reads as patterns, each `{parameter}` one path segment. */
const GATED_READS = [...TOKEN_READS].map(
  (template) => new RegExp(`^${template.replaceAll(/\{[^}]+\}/g, '[^/]+')}$`),
);

function gated(url: string, options: RequestInit): boolean {
  const path = operationPath(url);
  return (options.method ?? 'GET') !== 'GET' || GATED_READS.some((read) => read.test(path));
}

function bridgeRequest(url: string, options: RequestInit, token: string): Request {
  const path = operationPath(url);
  const request = new Request(new URL(url, document.baseURI), {
    ...options,
    signal:
      options.signal ??
      AbortSignal.timeout(path === '/status' ? STATUS_WITHIN_MS : ANSWER_WITHIN_MS),
  });
  if (token) request.headers.set('Authorization', `Bearer ${token}`);
  return request;
}

/** Orval's mutator: every generated bridge operation goes through here. */
export function bridgeFetch<T>(url: string, options: RequestInit): Promise<T> {
  const token = gated(url, options) ? heldToken.value : '';
  return bounded('bridge', exchange<T>(bridgeRequest(url, options, token), token !== ''));
}

async function exchange<T>(request: Request, withToken: boolean): Promise<T> {
  const response = await transport(request);
  // A recording stays bytes.
  if (response.ok && response.headers.get('Content-Type') === 'audio/wav') {
    return (await response.blob()) as T;
  }
  const text = await response.text();
  const body = parseBody(text);
  if (!response.ok) {
    // The token changed in the deployment: this tab no longer holds a working one.
    if (response.status === 401 && withToken) forgetBridgeToken();
    const error = (body as Partial<ErrorResponse> | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.message || text || String(response.status),
      error?.field ?? null,
    );
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

/** Ask the bridge whether it accepts `token`, apart from the one this tab holds. */
export async function bridgeAccepts(token: string): Promise<boolean> {
  try {
    await bounded(
      'bridge',
      exchange(bridgeRequest('./api/unlock', { method: 'POST' }, token), false),
    );
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false;
    throw error;
  }
}
