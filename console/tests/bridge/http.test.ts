import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeAccepts, setTransport } from '../../src/bridge/lib/http';
import { forgetBridgeToken, heldToken, holdBridgeToken } from '../../src/bridge/lib/token';
import { getBridgeStatus, getRecordings, setTransportMode } from '../../src/generated/bridge';
import { ApiError } from '../../src/shared/http';
import { bridgeStatus } from './fixtures';

const sent: Request[] = [];

function answer(response: () => Response) {
  setTransport(async (request) => {
    sent.push(request);
    return response();
  });
}

beforeEach(() => {
  sent.length = 0;
  holdBridgeToken('t'.repeat(16));
});

afterEach(() => {
  forgetBridgeToken();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('bridge requests', () => {
  it('carry the token on writes and the reads the contract gates, and nowhere else', async () => {
    answer(() => Response.json(bridgeStatus()));
    await getBridgeStatus();
    await getRecordings();
    await setTransportMode({ mode: 'tls-psk' });

    expect(sent.map((request) => request.headers.get('Authorization'))).toEqual([
      null,
      `Bearer ${'t'.repeat(16)}`,
      `Bearer ${'t'.repeat(16)}`,
    ]);
  });

  it('go to the bridge under the prefix the page is served at', async () => {
    window.history.replaceState(null, '', '/api/hassio_ingress/abc/');
    answer(() => Response.json(bridgeStatus()));
    await getBridgeStatus();

    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/api/hassio_ingress/abc/status');
  });

  it('report a refusal in the bridge’s words, on the field it names', async () => {
    answer(() =>
      Response.json(
        { error: { code: 'invalid-title', message: 'Enter a recording title.', field: 'title' } },
        { status: 400 },
      ),
    );
    const refused = await getRecordings().catch((error: unknown) => error);

    expect(refused).toMatchObject({
      status: 400,
      message: 'Enter a recording title.',
      field: 'title',
    });
    expect(refused).toBeInstanceOf(ApiError);
  });

  it('let go of a token the bridge stops accepting', async () => {
    answer(() =>
      Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
    );
    await expect(getRecordings()).rejects.toThrow('no');

    expect(heldToken.value).toBe('');
  });

  it('give up on a status read unanswered past five seconds', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const bounds: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      bounds.push(ms);
      return timeout(1);
    });
    setTransport(
      (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason)),
        ),
    );

    await expect(getBridgeStatus()).rejects.toThrow('the bridge did not answer in time');
    expect(bounds).toEqual([5_000]);
  });
});

describe('checking a token', () => {
  it('tells an accepted token from a refused one, sending the one asked about', async () => {
    answer(() => Response.json({ ok: true }));
    await expect(bridgeAccepts('candidate-token-1')).resolves.toBe(true);
    answer(() =>
      Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
    );
    await expect(bridgeAccepts('candidate-token-2')).resolves.toBe(false);

    expect(sent.map((request) => request.headers.get('Authorization'))).toEqual([
      'Bearer candidate-token-1',
      'Bearer candidate-token-2',
    ]);
    expect(heldToken.value).toBe('t'.repeat(16));
  });

  it('passes on why a bridge without a token cannot check one', async () => {
    answer(() =>
      Response.json(
        { error: { code: 'control-disabled', message: 'No bridge API token is set.' } },
        { status: 503 },
      ),
    );
    await expect(bridgeAccepts('candidate')).rejects.toThrow('No bridge API token is set.');
  });
});
