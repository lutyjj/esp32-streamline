import { describe, expect, it, vi } from 'vitest';
import type { Ack, DeviceConfig, TransportKeyResponse, TransportStatus } from '../src/lib/api';
import {
  type TransportApi,
  TransportController,
  transportActions,
  transportJourney,
} from '../src/state/transport';

const ack: Ack = { ok: true, rebooting: false, started: false };
const credential: TransportKeyResponse = {
  contract_version: 1,
  key_id: 'eli1-0123456789abcdef0123456789abcdef',
  psk: '01'.repeat(32),
};

function status(overrides: Partial<TransportStatus> = {}): TransportStatus {
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

function fakeApi(overrides: Partial<TransportApi> = {}): TransportApi {
  return {
    stage: vi.fn(async () => credential),
    verify: vi.fn(async () => ack),
    activate: vi.fn(async () => ack),
    discard: vi.fn(async () => ack),
    rollback: vi.fn(async () => ack),
    retire: vi.fn(async () => ack),
    recover: vi.fn(async () => credential),
    configure: vi.fn(async () => ack),
    ...overrides,
  };
}

describe('PCM transport lifecycle', () => {
  it('keeps first setup on explicit cleartext', () => {
    expect(transportActions(status())).toEqual({
      canStage: true,
      canVerify: false,
      canActivate: false,
      canDiscard: false,
      canRollback: false,
      canRetire: false,
    });
  });

  it('requires a successful verification before cutover', () => {
    expect(transportActions(status({ pending_key_id: credential.key_id }))).toMatchObject({
      canStage: false,
      canVerify: true,
      canActivate: false,
    });
    expect(
      transportActions(status({ pending_key_id: credential.key_id, pending_verified: true })),
    ).toMatchObject({ canVerify: false, canActivate: true });
  });

  it('shows one progressive journey step for each persisted state', () => {
    expect(transportJourney(status())).toBe('opt-in');
    expect(transportJourney(status({ pending_key_id: credential.key_id }))).toBe('provision');
    expect(
      transportJourney(status({ pending_key_id: credential.key_id, pending_verified: true })),
    ).toBe('activate');
    expect(transportJourney(status({ mode: 'tls-psk' }))).toBe('secure');
    expect(
      transportJourney(
        status({
          mode: 'tls-psk',
          rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
        }),
      ),
    ).toBe('rotation');
  });

  it('surfaces rotation rollback and retirement only when their keys exist', () => {
    expect(
      transportActions(
        status({
          mode: 'tls-psk',
          active_key_id: credential.key_id,
          rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
        }),
      ),
    ).toMatchObject({ canStage: false, canRollback: true, canRetire: true });
  });

  it('keeps a one-time key visible after staging and supports a failed verification retry', async () => {
    const verify = vi
      .fn<TransportApi['verify']>()
      .mockRejectedValueOnce(new Error('bridge rejected key'))
      .mockResolvedValueOnce(ack);
    const reload = vi.fn(async () => undefined);
    const controller = new TransportController(fakeApi({ verify }), reload);

    await controller.stage();
    expect(controller.revealed.value).toEqual({ ...credential, recovery: false });
    await expect(controller.verify()).rejects.toThrow('bridge rejected key');
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(controller.verify()).resolves.toEqual(ack);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('discards a pending key with its one-time reveal so setup can be abandoned', async () => {
    const api = fakeApi();
    const reload = vi.fn(async () => undefined);
    const controller = new TransportController(api, reload);

    await controller.stage();
    expect(transportActions(status({ pending_key_id: credential.key_id }))).toMatchObject({
      canDiscard: true,
    });
    await expect(controller.discard()).resolves.toEqual(ack);

    expect(api.discard).toHaveBeenCalledTimes(1);
    expect(controller.revealed.value).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost key into cleartext with a replacement shown once', async () => {
    const controller = new TransportController(fakeApi(), async () => undefined);

    await controller.recover();

    expect(controller.revealed.value).toEqual({ ...credential, recovery: true });
    controller.dismissReveal();
    expect(controller.revealed.value).toBeUndefined();
  });

  it('uses the version when explicitly returning the one listener to cleartext', async () => {
    const api = fakeApi();
    const controller = new TransportController(api, async () => undefined);
    const config = { transport: status({ contract_version: 1 }) } as DeviceConfig;

    await controller.useCleartext(config);

    expect(api.configure).toHaveBeenCalledWith({
      contract_version: 1,
      mode: 'cleartext',
    });
  });
});
