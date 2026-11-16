/** Audio security writes: the listener mode and device credentials, each read back from status. */

import * as v from 'valibot';
import {
  deleteTransportKey,
  putTransportKey,
  setTransportMode,
  type TransportModeRequestMode,
} from '../../generated/bridge';
import { PutTransportKeyParams, TransportKeyRequest } from '../../generated/bridgeRules';
import { readAgain } from '../../shared/queries';
import { withToken } from './access';
import { statusQuery } from './queries';

async function changeSecurity<T>(write: () => Promise<T>): Promise<T | null> {
  const done = await withToken(write);
  if (done !== null) await readAgain(statusQuery);
  return done;
}

/** A change of mode drops every connected device until it speaks the new one. */
export function setListenerMode(mode: TransportModeRequestMode) {
  return changeSecurity(() => setTransportMode({ mode }));
}

/** Replacing a key closes the sessions it authenticated. */
export function enrollKey(keyId: string, psk: string) {
  return changeSecurity(() => putTransportKey(keyId, { psk }));
}

/** Removing a key closes the sessions it authenticated. */
export function removeKey(keyId: string) {
  return changeSecurity(() => deleteTransportKey(keyId));
}

/** Why the contract refuses `value` as a credential ID, or null. */
export function keyIdProblem(value: string): string | null {
  return v.is(PutTransportKeyParams.entries.key_id, value)
    ? null
    : 'A credential ID is eli1- and 32 lowercase hexadecimal digits, as the device console shows it.';
}

/** Why the contract refuses `value` as a credential's key, or null. */
export function pskProblem(value: string): string | null {
  return v.is(TransportKeyRequest.entries.psk, value)
    ? null
    : 'A key is 64 lowercase hexadecimal digits, as the device console shows it.';
}
