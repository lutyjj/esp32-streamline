/**
 * Bridge changes need its API token, asked for when one is made, and asked
 * for once more when the bridge refuses the one held.
 */

import { effect } from '@preact/signals';
import { type CredentialHold, withCredential } from '../../shared/credentialGate';
import { queryClient } from '../../shared/queries';
import { bridgeAccepts } from '../lib/http';
import { forgetBridgeToken, heldToken, holdBridgeToken } from '../lib/token';
import { recordingsQuery } from './queries';

const tokenHold: CredentialHold = {
  required: () => true,
  unlocked: () => heldToken.value !== '',
  lock: forgetBridgeToken,
};

/** Run `write` with the token, asking for it when none is held. Resolves null when declined. */
export function withToken<T>(write: () => Promise<T>): Promise<T | null> {
  return withCredential(tokenHold, write);
}

/** The credential dialog's check: the console unlocks with a token the bridge accepts. */
export async function unlockWithToken(token: string): Promise<'accepted' | 'rejected'> {
  if (!(await bridgeAccepts(token))) return 'rejected';
  holdBridgeToken(token);
  return 'accepted';
}

// The recording list needs the token, so it goes with it, and the next unlock reads it again.
effect(() => {
  if (heldToken.value === '') queryClient.removeQueries({ queryKey: recordingsQuery.queryKey });
});
