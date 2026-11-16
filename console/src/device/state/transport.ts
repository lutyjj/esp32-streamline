/**
 * Encrypted audio: where the device's credential stands, the lifecycle
 * writes, and the one-time reveal of a credential it makes.
 * docs/tcp-transport.md owns the sequence.
 */

import { signal } from '@preact/signals';
import {
  type Ack,
  activateTransportKey,
  discardTransportKey,
  recoverTransport,
  retireTransportKey,
  rollbackTransportKey,
  setTransportMode,
  stageTransportKey,
  type TransportKeyResponse,
  type TransportStatus,
  verifyTransportKey,
} from '../../generated/api';
import { withAccess, withRestart } from './access';
import { readAgain, settingsQuery } from './queries';

/** A credential the device made, shown once; `recovery` when it replaced a lost one. */
export interface RevealedKey extends TransportKeyResponse {
  recovery: boolean;
}

/** The credential this visit made, until it is activated or discarded. */
export const revealed = signal<RevealedKey | null>(null);

/** The guide's steps: make a credential, add it to the bridge and verify, turn it on. */
export type EncryptionStep = 'credential' | 'bridge' | 'activate';

/** Where the guide stands for the device's key state; it resumes there. */
export function encryptionStep(status: TransportStatus): EncryptionStep {
  if (!status.pending_key_id) return 'credential';
  return status.pending_verified ? 'activate' : 'bridge';
}

/**
 * Which lifecycle writes the key state allows. The device keeps two slots,
 * so a new credential waits until the previous one is retired or rolled
 * back to, and nothing but the pending key moves while one is staged.
 */
export function keyActions(status: TransportStatus) {
  const previous = Boolean(status.rollback_key_id) && !status.pending_key_id;
  return {
    stage: !status.pending_key_id && !status.rollback_key_id,
    rollBack: previous,
    retire: previous,
  };
}

/** A write that moves the key state, which the settings carry. */
async function keyWrite(write: () => Promise<Ack>): Promise<Ack | null> {
  const done = await withAccess(write);
  if (done) await readAgain(settingsQuery);
  return done;
}

/**
 * Make a credential, or with `recovery` replace a lost one and select
 * cleartext for the next start. The device shows its PSK this once.
 */
export async function makeKey(recovery = false): Promise<boolean> {
  const key = await withAccess(() => (recovery ? recoverTransport() : stageTransportKey()));
  if (!key) return false;
  revealed.value = { ...key, recovery };
  await readAgain(settingsQuery);
  return true;
}

/** The device makes a real handshake with the bridge on its target. */
export function verifyKey(): Promise<Ack | null> {
  return keyWrite(() => verifyTransportKey());
}

/** Abandon the staged credential; the device stays as it was. */
export async function discardKey(): Promise<Ack | null> {
  const done = await keyWrite(() => discardTransportKey());
  if (done) revealed.value = null;
  return done;
}

/** Promote the verified credential and restart into encrypted audio. */
export async function activateKey(): Promise<Ack | null> {
  const done = await withRestart('the switch to encryption', () => activateTransportKey());
  if (done) revealed.value = null;
  return done;
}

export function rollBackKey(): Promise<Ack | null> {
  return withRestart('the credential rollback', () => rollbackTransportKey());
}

export function retireKey(): Promise<Ack | null> {
  return keyWrite(() => retireTransportKey());
}

/** Restart into cleartext; the bridge must already accept it. */
export function returnToCleartext(status: TransportStatus): Promise<Ack | null> {
  return withRestart('the switch to cleartext', () =>
    setTransportMode({ contract_version: status.contract_version, mode: 'cleartext' }),
  );
}
