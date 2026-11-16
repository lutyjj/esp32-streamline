/**
 * Bridge changes need its API token, asked for when one is made, and asked
 * for once more when the bridge refuses the one held. A bridge whose
 * deployment sets no token takes no change, and nothing asks for one.
 */

import { effect } from '@preact/signals';
import { useQuery } from '@tanstack/preact-query';
import { type CredentialHold, withCredential } from '../../shared/credentialGate';
import { queryClient } from '../../shared/queries';
import { bridgeAccepts } from '../lib/http';
import { forgetBridgeToken, heldToken, holdBridgeToken } from '../lib/token';
import { recordingsQuery, statusQuery } from './queries';

/** The deployment set a token; until status says otherwise, assume it did. */
function tokenConfigured(): boolean {
  return queryClient.getQueryData(statusQuery.queryKey)?.api_token_configured !== false;
}

/** The bridge takes no change: its deployment sets no token, so the screens offer none. */
export function useReadOnly(): boolean {
  return useQuery(statusQuery, queryClient).data?.api_token_configured === false;
}

// Without a token in the deployment, a write goes unasked and the bridge refuses it in its own words.
const tokenHold: CredentialHold = {
  required: tokenConfigured,
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
