/** Tested state and actions for the device PCM transport lifecycle. */

import { signal } from '@preact/signals';
import {
  type Ack,
  activateTransportKey,
  type DeviceConfig,
  recoverTransport,
  retireTransportKey,
  rollbackTransportKey,
  setTransportSettings,
  stageTransportKey,
  type TransportKeyResponse,
  type TransportSettingsRequest,
  type TransportStatus,
  verifyTransportKey,
} from '../lib/api';
import { loadConfig } from './device';

export interface TransportApi {
  stage(): Promise<TransportKeyResponse>;
  verify(): Promise<Ack>;
  activate(): Promise<Ack>;
  rollback(): Promise<Ack>;
  retire(): Promise<Ack>;
  recover(): Promise<TransportKeyResponse>;
  configure(request: TransportSettingsRequest): Promise<Ack>;
}

export interface RevealedTransportKey extends TransportKeyResponse {
  recovery: boolean;
}

export interface TransportActions {
  canStage: boolean;
  canVerify: boolean;
  canActivate: boolean;
  canRollback: boolean;
  canRetire: boolean;
}

const runtimeApi: TransportApi = {
  stage: stageTransportKey,
  verify: verifyTransportKey,
  activate: activateTransportKey,
  rollback: rollbackTransportKey,
  retire: retireTransportKey,
  recover: recoverTransport,
  configure: setTransportSettings,
};

export function transportActions(status: TransportStatus): TransportActions {
  return {
    canStage: !status.pending_key_id,
    canVerify: Boolean(status.pending_key_id) && !status.pending_verified,
    canActivate: Boolean(status.pending_key_id) && status.pending_verified,
    canRollback: status.mode === 'tls-psk' && Boolean(status.rollback_key_id),
    canRetire: Boolean(status.rollback_key_id),
  };
}

export class TransportController {
  readonly revealed = signal<RevealedTransportKey>();

  constructor(
    private readonly api: TransportApi = runtimeApi,
    private readonly reload: () => Promise<void> = loadConfig,
  ) {}

  async stage(): Promise<undefined> {
    this.revealed.value = { ...(await this.api.stage()), recovery: false };
    await this.reload();
    return undefined;
  }

  async verify(): Promise<Ack> {
    const response = await this.api.verify();
    await this.reload();
    return response;
  }

  activate(): Promise<Ack> {
    return this.api.activate();
  }

  rollback(): Promise<Ack> {
    return this.api.rollback();
  }

  async retire(): Promise<Ack> {
    const response = await this.api.retire();
    await this.reload();
    return response;
  }

  async recover(): Promise<undefined> {
    this.revealed.value = { ...(await this.api.recover()), recovery: true };
    await this.reload();
    return undefined;
  }

  useCleartext(config: DeviceConfig, cleartextPort: number, securePort: number): Promise<Ack> {
    return this.api.configure({
      contract_version: config.transport.contract_version,
      mode: 'cleartext',
      cleartext_port: cleartextPort,
      secure_port: securePort,
    });
  }

  dismissReveal(): void {
    this.revealed.value = undefined;
  }
}

export const transport = new TransportController();
