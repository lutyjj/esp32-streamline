/**
 * RFC 7616 digest authentication client (SHA-256, `qop=auth`).
 *
 * The device never sees the admin key on the wire: it challenges with a
 * nonce, and the client answers with a hash binding the key, the nonce, a
 * per-request counter, and the request's method and path. SHA-256 comes
 * from `@noble/hashes` because `crypto.subtle` is unavailable on the
 * insecure origin the device console runs on.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** The one account the single-owner device has. */
export const DIGEST_USERNAME = 'admin';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  /** The key was not disproven; only the nonce needs renewing. */
  stale: boolean;
}

/**
 * Parse the fields of a `Digest` header value (a challenge or credentials);
 * null for another scheme. Quoted values may contain commas.
 */
export function parseDigestFields(header: string | null): Map<string, string> | null {
  if (!header?.startsWith('Digest ')) return null;
  const fields = new Map<string, string>();
  for (const match of header.slice('Digest '.length).matchAll(/(\w+)=(?:"([^"]*)"|([^",\s]+))/g)) {
    fields.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }
  return fields;
}

/**
 * A usable challenge from a 401's `WWW-Authenticate` value, or null when the
 * server is not offering SHA-256 digest with `qop=auth`.
 */
export function parseChallenge(header: string | null): DigestChallenge | null {
  const fields = parseDigestFields(header);
  const realm = fields?.get('realm');
  const nonce = fields?.get('nonce');
  if (!fields || !realm || !nonce) return null;
  const algorithm = fields.get('algorithm');
  if (algorithm && algorithm !== 'SHA-256') return null;
  const qop = fields.get('qop');
  if (qop && !qop.split(',').some((offered) => offered.trim() === 'auth')) return null;
  return { realm, nonce, stale: fields.get('stale') === 'true' };
}

/** The RFC 7616 `response` hash for `algorithm=SHA-256, qop=auth`. */
export function digestResponse(
  username: string,
  realm: string,
  key: string,
  method: string,
  uri: string,
  nonce: string,
  nc: string,
  cnonce: string,
): string {
  const ha1 = hash(`${username}:${realm}:${key}`);
  const ha2 = hash(`${method}:${uri}`);
  return hash(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
}

/**
 * One accepted challenge plus this client's nonce count. Reusing the session
 * keeps a write to one round trip; the count must only grow, so the device
 * can refuse a replayed exchange.
 */
export class DigestSession {
  private nc = 0;

  constructor(private readonly challenge: DigestChallenge) {}

  /** The `Authorization` value for one request. Each call consumes a count. */
  authorization(key: string, method: string, uri: string): string {
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, '0');
    const cnonce = randomCnonce();
    const { realm, nonce } = this.challenge;
    const response = digestResponse(DIGEST_USERNAME, realm, key, method, uri, nonce, nc, cnonce);
    return (
      `Digest username="${DIGEST_USERNAME}", realm="${realm}", nonce="${nonce}", ` +
      `uri="${uri}", response="${response}", qop=auth, nc=${nc}, ` +
      `cnonce="${cnonce}", algorithm=SHA-256`
    );
  }
}

function hash(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

function randomCnonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
