import { describe, expect, it } from 'vitest';
import {
  DIGEST_USERNAME,
  DigestSession,
  digestResponse,
  parseChallenge,
  parseDigestFields,
} from '../src/lib/digest';

describe('digest response', () => {
  // The SHA-256 example from RFC 7616 section 3.9.1 pins the hash chain to
  // the standard, the same vector the firmware's own tests pin.
  it('matches the RFC 7616 SHA-256 vector', () => {
    expect(
      digestResponse(
        'Mufasa',
        'http-auth@example.org',
        'Circle of Life',
        'GET',
        '/dir/index.html',
        '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
        '00000001',
        'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
      ),
    ).toBe('753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
  });
});

describe('challenge parsing', () => {
  it('reads the firmware challenge shape', () => {
    expect(
      parseChallenge('Digest realm="streamline", qop="auth", algorithm=SHA-256, nonce="abc123"'),
    ).toEqual({ realm: 'streamline', nonce: 'abc123', stale: false });
  });

  it('carries the stale flag through', () => {
    expect(
      parseChallenge('Digest realm="streamline", qop="auth", nonce="abc", stale=true')?.stale,
    ).toBe(true);
  });

  it('rejects other schemes and algorithms it cannot answer', () => {
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge('Basic realm="streamline"')).toBeNull();
    expect(parseChallenge('Digest realm="r", nonce="n", algorithm=MD5')).toBeNull();
    expect(parseChallenge('Digest realm="r", nonce="n", qop="auth-int"')).toBeNull();
  });

  it('keeps commas inside quoted values whole', () => {
    const fields = parseDigestFields('Digest uri="/api/x,y", nc=00000001');
    expect(fields?.get('uri')).toBe('/api/x,y');
    expect(fields?.get('nc')).toBe('00000001');
  });
});

describe('digest session', () => {
  it('answers with a verifiable response and a growing nonce count', () => {
    const session = new DigestSession({ realm: 'streamline', nonce: 'nonce-1', stale: false });

    for (const expectedNc of ['00000001', '00000002']) {
      const fields = parseDigestFields(session.authorization('key', 'POST', '/api/restart'));
      expect(fields?.get('username')).toBe(DIGEST_USERNAME);
      expect(fields?.get('realm')).toBe('streamline');
      expect(fields?.get('uri')).toBe('/api/restart');
      expect(fields?.get('nc')).toBe(expectedNc);
      expect(fields?.get('response')).toBe(
        digestResponse(
          DIGEST_USERNAME,
          'streamline',
          'key',
          'POST',
          '/api/restart',
          'nonce-1',
          expectedNc,
          fields?.get('cnonce') ?? '',
        ),
      );
    }
  });
});
