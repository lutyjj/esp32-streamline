import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeBase,
  bridgeFetch,
  bridgeToken,
  rememberBridgeToken,
  SECURED_OPERATIONS,
  setAuthRejectedHandler,
  setBridgeTransport,
} from '../src/bridge/http';

describe('bridge HTTP transport', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="ingress-base" content="/api/hassio_ingress/session">';
    sessionStorage.clear();
  });

  it('scopes requests to Home Assistant ingress and authenticates recording operations', async () => {
    rememberBridgeToken('secret');
    const transport = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('{}'),
    );
    setBridgeTransport(transport);

    await bridgeFetch('/api/recordings', { method: 'GET' });

    const request = transport.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('request missing');
    expect(request.url).toContain('/api/hassio_ingress/session/api/recordings');
    expect(request.headers.get('Authorization')).toBe('Bearer secret');
  });

  it('rejects an unsafe ingress prefix', () => {
    document.head.innerHTML = '<meta name="ingress-base" content="<script>bad</script>">';
    expect(bridgeBase()).toBe('');
  });

  it('sends the one bridge token to every mutating route and to no open read', async () => {
    rememberBridgeToken('bridge-secret');
    const transport = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('{}'),
    );
    setBridgeTransport(transport);

    await bridgeFetch('/api/transport/keys/eli1-0123456789abcdef0123456789abcdef', {
      method: 'PUT',
    });
    await bridgeFetch('/api/transport/mode', { method: 'PUT' });
    await bridgeFetch('/api/unlock', { method: 'POST' });
    await bridgeFetch('/api/transport', { method: 'GET' });
    await bridgeFetch('/api/recordings/capabilities', { method: 'GET' });

    const authorization = transport.mock.calls.map((call) => call[0].headers.get('Authorization'));
    expect(authorization).toEqual([
      'Bearer bridge-secret',
      'Bearer bridge-secret',
      'Bearer bridge-secret',
      null,
      null,
    ]);
  });
});

describe('authorization derives from the generated contract', () => {
  it('classifies every artifact operation exactly — a new one fails here', () => {
    const artifact = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../docs/bridge-openapi.json'), 'utf8'),
    ) as {
      paths?: Record<string, Record<string, { security?: unknown[] }>>;
    };
    const declared = new Set<string>();
    for (const [path, item] of Object.entries(artifact.paths ?? {})) {
      for (const [method, op] of Object.entries(item)) {
        if (op && typeof op === 'object' && 'security' in op && op.security?.length) {
          declared.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(new Set(SECURED_OPERATIONS)).toEqual(declared);
  });

  it('locks once on an authenticated 401: token forgotten, handler notified', async () => {
    rememberBridgeToken('stale');
    const onLock = vi.fn();
    setAuthRejectedHandler(onLock);
    setBridgeTransport(async () => new Response('{"error":{"message":"denied"}}', { status: 401 }));

    await expect(bridgeFetch('/api/recordings', { method: 'GET' })).rejects.toThrow('denied');
    expect(onLock).toHaveBeenCalledOnce();
    expect(bridgeToken()).toBe('');
    setAuthRejectedHandler(() => {});
  });

  it('keeps 400 and 409 as ordinary retryable errors', async () => {
    rememberBridgeToken('valid');
    const onLock = vi.fn();
    setAuthRejectedHandler(onLock);
    setBridgeTransport(async () => new Response('{"error":{"message":"busy"}}', { status: 409 }));

    await expect(bridgeFetch('/api/recordings', { method: 'POST' })).rejects.toThrow('busy');
    expect(onLock).not.toHaveBeenCalled();
    expect(bridgeToken()).toBe('valid');
    setAuthRejectedHandler(() => {});
  });

  it('never locks on a 401 from an open route', async () => {
    const onLock = vi.fn();
    setAuthRejectedHandler(onLock);
    setBridgeTransport(async () => new Response('nope', { status: 401 }));

    await expect(bridgeFetch('/status', { method: 'GET' })).rejects.toThrow();
    expect(onLock).not.toHaveBeenCalled();
    setAuthRejectedHandler(() => {});
  });
});
