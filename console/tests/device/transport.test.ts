import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { connection, refresh } from '../../src/device/state/device';
import { queryClient, settingsQuery } from '../../src/device/state/queries';
import {
  activateKey,
  discardKey,
  encryptionStep,
  keyActions,
  makeKey,
  retireKey,
  returnToCleartext,
  revealed,
  verifyKey,
} from '../../src/device/state/transport';
import type { TransportStatus } from '../../src/generated/api';
import { answering } from './answering';

const keyId = 'eli1-0123456789abcdef0123456789abcdef';

function keys(overrides: Partial<TransportStatus> = {}): TransportStatus {
  return {
    contract_version: 1,
    mode: 'cleartext',
    active_key_id: null,
    pending_key_id: null,
    pending_verified: false,
    rollback_key_id: null,
    ...overrides,
  };
}

describe('where the key stands', () => {
  it('resumes the guide at the step the device reports', () => {
    expect(encryptionStep(keys())).toBe('credential');
    expect(encryptionStep(keys({ pending_key_id: keyId }))).toBe('bridge');
    expect(encryptionStep(keys({ pending_key_id: keyId, pending_verified: true }))).toBe(
      'activate',
    );
  });

  it('holds a new credential until the previous one is retired or gone back to', () => {
    const rotated = keys({ mode: 'tls-psk', active_key_id: keyId, rollback_key_id: 'eli1-old' });
    expect(keyActions(rotated)).toEqual({ stage: false, rollBack: true, retire: true });
    expect(keyActions(keys({ ...rotated, pending_key_id: 'eli1-new' }))).toEqual({
      stage: false,
      rollBack: false,
      retire: false,
    });
    expect(keyActions(keys({ mode: 'tls-psk', active_key_id: keyId })).stage).toBe(true);
  });
});

describe('the key lifecycle', () => {
  let device: FakeDevice;

  /** The fake device's answer; `dropped` paths are applied but never answered. */
  function answeredBy(dropped = '') {
    return async (request: Request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      if (response.ok && dropped && request.url.endsWith(dropped)) {
        throw new TypeError('Failed to fetch');
      }
      return response;
    };
  }

  beforeEach(async () => {
    device = new FakeDevice('steady');
    setTransport(answeredBy());
    unlockSettings(MOCK_ADMIN_KEY, false);
    queryClient.clear();
    revealed.value = null;
    await Promise.all([refresh(), queryClient.query(settingsQuery)]);
  });

  afterEach(() => {
    forgetAdminKey();
    answering(null);
    setTransport((request) => fetch(request));
  });

  const transport = () => queryClient.getQueryData(settingsQuery.queryKey)?.transport;

  /** Poll until the device answers from its new start. */
  async function restarted(): Promise<void> {
    for (let read = 0; read < 6 && connection.value.phase !== 'live'; read += 1) await refresh();
  }

  it('shows a credential once, verifies it, and restarts into it', async () => {
    await expect(makeKey()).resolves.toBe(true);
    const made = revealed.value;
    expect(made).toMatchObject({ recovery: false, key_id: transport()?.pending_key_id });
    expect(made?.psk).toMatch(/^[0-9a-f]{64}$/);

    await verifyKey();
    expect(transport()?.pending_verified).toBe(true);

    await activateKey();
    expect(revealed.value).toBeNull();
    expect(connection.value).toMatchObject({
      phase: 'waiting',
      operation: 'the switch to encryption',
    });
  });

  it('reads the key state again when a credential is made but the answer is lost', async () => {
    setTransport(answeredBy('/api/transport/keys/stage'));
    await expect(makeKey()).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(transport()?.pending_key_id).toMatch(/^eli1-/));
  });

  it('reads the key state again after a restart whose answer is lost', async () => {
    await makeKey();
    await verifyKey();
    setTransport(answeredBy('/api/transport/keys/activate'));
    await expect(activateKey()).rejects.toThrow(TypeError);
    // The console saw no restart reported; the poll finds the device's new start.
    for (let read = 0; read < 4; read += 1) await refresh();
    await queryClient.query(settingsQuery);
    expect(transport()).toMatchObject({ mode: 'tls-psk', pending_key_id: null });
  });

  it('discards a staged credential with its reveal', async () => {
    await makeKey();
    await discardKey();
    expect(revealed.value).toBeNull();
    expect(transport()?.pending_key_id).toBeNull();
  });

  it('replaces a lost credential, shown once, and starts in the clear', async () => {
    await makeKey(true);
    expect(revealed.value?.recovery).toBe(true);
    expect(transport()).toMatchObject({ mode: 'cleartext', pending_verified: false });
  });

  /** Turn encryption on, then replace its credential, which keeps the first as the previous one. */
  async function rotated(): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      await makeKey();
      await verifyKey();
      await activateKey();
      await restarted();
    }
    await queryClient.query({ ...settingsQuery, staleTime: 0 });
    expect(transport()?.rollback_key_id).not.toBeNull();
  }

  it('makes no credential while the previous one is kept, even in the clear', async () => {
    await rotated();
    const now = transport();
    if (!now) throw new Error('no settings');
    await returnToCleartext(now);
    await restarted();
    await expect(makeKey()).rejects.toThrow('retire the PCM transport rollback key');

    await retireKey();
    await expect(makeKey()).resolves.toBe(true);
  });

  it('drops the previous credential when it replaces a lost one', async () => {
    await rotated();
    await makeKey(true);
    expect(transport()).toMatchObject({ mode: 'cleartext', rollback_key_id: null });
  });

  it('retires the previous credential and returns to cleartext with a restart', async () => {
    await rotated();
    await retireKey();
    expect(transport()?.rollback_key_id).toBeNull();
    const now = transport();
    if (!now) throw new Error('no settings');
    await returnToCleartext(now);
    expect(connection.value).toMatchObject({
      phase: 'waiting',
      operation: 'the switch to cleartext',
    });
  });
});
