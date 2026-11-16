/**
 * Music Assistant pairing: a token made for one source, shown until it is
 * dismissed or the console locks. Each request replaces the source's pairing
 * secret, so a failed one may have spent the token on screen, which goes
 * before it is sent.
 */

import { effect, signal } from '@preact/signals';
import { createSendspinPairingToken, type SendspinPairingToken } from '../../generated/bridge';
import { heldToken } from '../lib/token';
import { withToken } from './access';

/** The pairing token last made, while it is on screen. */
export const revealedPairing = signal<SendspinPairingToken | null>(null);

// It is a secret: locking, or a token the bridge stops accepting, takes it away.
effect(() => {
  if (heldToken.value === '') revealedPairing.value = null;
});

export async function makePairingToken(source: string): Promise<SendspinPairingToken | null> {
  revealedPairing.value = null;
  const made = await withToken(() => createSendspinPairingToken(source));
  revealedPairing.value = made;
  return made;
}
