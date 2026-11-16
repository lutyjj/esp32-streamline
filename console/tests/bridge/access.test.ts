import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/bridge/lib/http';
import { forgetBridgeToken, heldToken, holdBridgeToken } from '../../src/bridge/lib/token';
import { unlockWithToken, withToken } from '../../src/bridge/state/access';
import { makePairingToken, revealedPairing } from '../../src/bridge/state/pairing';
import { recordingsQuery, statusQuery } from '../../src/bridge/state/queries';
import { answerCredential, credentialAsked } from '../../src/shared/credentialGate';
import { ApiError } from '../../src/shared/http';
import { queryClient } from '../../src/shared/queries';
import { bridgeStatus, recordingList, SOURCE } from './fixtures';

const TOKEN = 't'.repeat(16);

beforeEach(() => forgetBridgeToken());

afterEach(() => {
  if (credentialAsked.value) answerCredential(false);
  queryClient.clear();
});

async function answerWhenAsked(token: string | null): Promise<void> {
  await vi.waitFor(() => expect(credentialAsked.value).toBe(true));
  if (token) holdBridgeToken(token);
  answerCredential(token !== null);
}

describe('bridge writes', () => {
  it('ask for the token while locked, then write', async () => {
    const write = vi.fn(async () => 'done');
    const done = withToken(write);
    await answerWhenAsked(TOKEN);

    await expect(done).resolves.toBe('done');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('write nothing when the unlock is declined', async () => {
    const write = vi.fn(async () => 'done');
    const done = withToken(write);
    await answerWhenAsked(null);

    await expect(done).resolves.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('ask once more when the bridge refuses the token held', async () => {
    holdBridgeToken('stale-token-0000');
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(401, 'no'))
      .mockResolvedValueOnce('done');
    const done = withToken(write);
    await answerWhenAsked(TOKEN);

    await expect(done).resolves.toBe('done');
    expect(heldToken.value).toBe(TOKEN);
  });
});

describe('a bridge whose deployment sets no token', () => {
  it('is never asked for one: the write goes and the bridge refuses it in its own words', async () => {
    queryClient.setQueryData(statusQuery.queryKey, {
      ...bridgeStatus(),
      api_token_configured: false,
    });
    const write = vi.fn(async () => {
      throw new ApiError(503, 'No bridge API token is set.');
    });

    await expect(withToken(write)).rejects.toThrow('No bridge API token is set.');
    expect(write).toHaveBeenCalledTimes(1);
    expect(credentialAsked.value).toBe(false);
  });
});

describe('unlocking', () => {
  it('holds a token only once the bridge accepts it', async () => {
    setTransport(async (request) =>
      request.headers.get('Authorization') === `Bearer ${TOKEN}`
        ? Response.json({ ok: true })
        : Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
    );
    await expect(unlockWithToken('wrong-token-0000')).resolves.toBe('rejected');
    expect(heldToken.value).toBe('');
    await expect(unlockWithToken(TOKEN)).resolves.toBe('accepted');
    expect(heldToken.value).toBe(TOKEN);
  });
});

describe('locking', () => {
  it('takes away a revealed pairing token and the recording list', async () => {
    holdBridgeToken(TOKEN);
    setTransport(async () =>
      Response.json(
        { source: SOURCE, client_id: 'client', token: 'pairing-secret' },
        { status: 201 },
      ),
    );
    await makePairingToken(SOURCE);
    queryClient.setQueryData(recordingsQuery.queryKey, recordingList());
    expect(revealedPairing.value?.token).toBe('pairing-secret');

    forgetBridgeToken();

    expect(revealedPairing.value).toBeNull();
    expect(queryClient.getQueryData(recordingsQuery.queryKey)).toBeUndefined();
  });

  it('a failed pairing request takes the token on screen with it, since it may have replaced it', async () => {
    holdBridgeToken(TOKEN);
    revealedPairing.value = { source: SOURCE, client_id: 'client', token: 'earlier' };
    setTransport(async () =>
      Response.json({ error: { code: 'sendspin-busy', message: 'busy' } }, { status: 503 }),
    );

    await expect(makePairingToken(SOURCE)).rejects.toThrow('busy');
    expect(revealedPairing.value).toBeNull();
  });
});
