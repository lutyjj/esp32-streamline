import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeBase,
  bridgeFetch,
  rememberRecordingToken,
  setBridgeTransport,
} from '../src/bridge/http';

describe('bridge HTTP transport', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="ingress-base" content="/api/hassio_ingress/session">';
    sessionStorage.clear();
  });

  it('scopes requests to Home Assistant ingress and authenticates recording operations', async () => {
    rememberRecordingToken('secret');
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
});
