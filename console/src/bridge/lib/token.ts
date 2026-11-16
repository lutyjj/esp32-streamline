/**
 * The bridge API token this tab holds. It is a deployment secret every
 * bridge change shares, so it lives in this tab's session storage only and
 * goes when the tab does (docs/security.md).
 */

import { signal } from '@preact/signals';
import { sessionStore } from '../../shared/custody';

const TOKEN_KEY = 'streamline:bridge-token';

/** The held token, or '' while the console is locked. */
export const heldToken = signal(sessionStore.get(TOKEN_KEY) ?? '');

export function holdBridgeToken(token: string): void {
  sessionStore.set(TOKEN_KEY, token);
  heldToken.value = token;
}

export function forgetBridgeToken(): void {
  sessionStore.remove(TOKEN_KEY);
  heldToken.value = '';
}
