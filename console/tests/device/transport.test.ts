import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  beforeEach(async () => {
    const device = new FakeDevice('steady');
    setTransport(async (request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    });
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

  it('retires the previous credential and returns to cleartext with a restart', async () => {
    for (let round = 0; round < 2; round += 1) {
      await makeKey();
      await verifyKey();
      await activateKey();
      await restarted();
    }
    await queryClient.query({ ...settingsQuery, staleTime: 0 });
    expect(transport()?.rollback_key_id).not.toBeNull();

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
