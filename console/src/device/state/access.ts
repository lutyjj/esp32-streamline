/**
 * Writes that need the admin key ask for it when they need it. A locked
 * console opens the credential dialog, and a write the device refuses for its
 * key asks once more before it gives up.
 */

import { type Ack, setAdminKey } from '../../generated/api';
import { requestCredential } from '../../shared/credentialGate';
import { ApiError } from '../../shared/http';
import {
  isUnlocked,
  keyRemembered,
  lockSettings,
  replaceAdminKey,
  unlockSettings,
} from '../lib/adminKey';
import { verifyAdminKey } from '../lib/http';
import { report, status } from './device';

/** The device holds an admin key, so its writes need one. */
function keyRequired(): boolean {
  return status.value?.auth_required ?? true;
}

/**
 * Run `write` with the admin key, asking for the key first when the console
 * is locked. Resolves null when the person declines to unlock.
 */
export async function withAccess<T>(write: () => Promise<T>): Promise<T | null> {
  if (keyRequired() && !isUnlocked() && !(await requestCredential())) return null;
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
    // The key changed, or the window closed while the write was on its way.
    lockSettings();
    if (!(await requestCredential())) return null;
    return write();
  }
}

/** The credential dialog's check: the console unlocks with a key the device accepts. */
export async function unlockWithKey(
  key: string,
  remember: boolean,
): Promise<'accepted' | 'rejected'> {
  if (!(await verifyAdminKey(key))) return 'rejected';
  unlockSettings(key, remember);
  return 'accepted';
}

/**
 * Run a write that the device may answer by restarting, and follow that
 * restart as `operation`, such as "the profile". Resolves null when the owner
 * declines to unlock.
 */
export async function withRestart(
  operation: string,
  write: () => Promise<Ack>,
): Promise<Ack | null> {
  const ack = await withAccess(write);
  if (ack?.rebooting) report({ type: 'restarting', operation, at: Date.now() });
  return ack;
}

/**
 * Give the device `next` as its admin key and keep this browser unlocked on
 * it, kept the way the old one was. Resolves null when the owner declines to
 * unlock.
 */
export function changeAdminKey(next: string): Promise<Ack | null> {
  return withAccess(() =>
    replaceAdminKey((secret) => setAdminKey({ admin_key: secret }), next, keyRemembered()),
  );
}
