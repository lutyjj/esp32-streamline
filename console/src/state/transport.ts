/** Tested state and actions for the device PCM transport lifecycle. */

import { signal } from '@preact/signals';
import {
  type Ack,
  activateTransportKey,
  type DeviceConfig,
  discardTransportKey,
  recoverTransport,
  retireTransportKey,
  rollbackTransportKey,
  setTransportMode,
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
  discard(): Promise<Ack>;
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
  canDiscard: boolean;
  canRollback: boolean;
  canRetire: boolean;
}

export type TransportJourney = 'opt-in' | 'provision' | 'activate' | 'secure' | 'rotation';

const runtimeApi: TransportApi = {
  stage: stageTransportKey,
  verify: verifyTransportKey,
  activate: activateTransportKey,
  discard: discardTransportKey,
  rollback: rollbackTransportKey,
  retire: retireTransportKey,
  recover: recoverTransport,
  configure: setTransportMode,
};

export function transportActions(status: TransportStatus): TransportActions {
  return {
    canStage: !status.pending_key_id && !status.rollback_key_id,
    canVerify: Boolean(status.pending_key_id) && !status.pending_verified,
    canActivate: Boolean(status.pending_key_id) && status.pending_verified,
    canDiscard: Boolean(status.pending_key_id),
    canRollback: status.mode === 'tls-psk' && Boolean(status.rollback_key_id),
    canRetire: Boolean(status.rollback_key_id),
  };
}

export function transportJourney(status: TransportStatus): TransportJourney {
  if (status.pending_key_id) return status.pending_verified ? 'activate' : 'provision';
  if (status.rollback_key_id) return 'rotation';
  return status.mode === 'tls-psk' ? 'secure' : 'opt-in';
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

  /** Abandon the staged key and its one-time reveal; nothing was cut over. */
  async discard(): Promise<Ack> {
    const response = await this.api.discard();
    this.revealed.value = undefined;
    await this.reload();
    return response;
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

  useCleartext(config: DeviceConfig): Promise<Ack> {
    return this.api.configure({
      contract_version: config.transport.contract_version,
      mode: 'cleartext',
    });
  }

  dismissReveal(): void {
    this.revealed.value = undefined;
  }
}

export const transport = new TransportController();
