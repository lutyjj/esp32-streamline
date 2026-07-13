import { describe, expect, it, vi } from 'vitest';
import type { Ack, DeviceConfig, TransportKeyResponse, TransportStatus } from '../src/lib/api';
import { type TransportApi, TransportController, transportActions } from '../src/state/transport';

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
    cleartext_port: 39000,
    secure_port: 39001,
    effective_port: 39000,
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
    rollback: vi.fn(async () => ack),
    retire: vi.fn(async () => ack),
    recover: vi.fn(async () => credential),
    configure: vi.fn(async () => ack),
    ...overrides,
  };
}

describe('PCM transport lifecycle', () => {
  it('keeps first setup and legacy coexistence on explicit cleartext', () => {
    expect(transportActions(status())).toEqual({
      canStage: true,
      canVerify: false,
      canActivate: false,
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

  it('surfaces rotation rollback and retirement only when their keys exist', () => {
    expect(
      transportActions(
        status({
          mode: 'tls-psk',
          active_key_id: credential.key_id,
          rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
        }),
      ),
    ).toMatchObject({ canRollback: true, canRetire: true });
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

  it('recovers a lost key into cleartext with a replacement shown once', async () => {
    const controller = new TransportController(fakeApi(), async () => undefined);

    await controller.recover();

    expect(controller.revealed.value).toEqual({ ...credential, recovery: true });
    controller.dismissReveal();
    expect(controller.revealed.value).toBeUndefined();
  });

  it('uses the version and both listener ports when explicitly returning to cleartext', async () => {
    const api = fakeApi();
    const controller = new TransportController(api, async () => undefined);
    const config = { transport: status({ contract_version: 1 }) } as DeviceConfig;

    await controller.useCleartext(config, 39100, 39101);

    expect(api.configure).toHaveBeenCalledWith({
      contract_version: 1,
      mode: 'cleartext',
      cleartext_port: 39100,
      secure_port: 39101,
    });
  });
});
