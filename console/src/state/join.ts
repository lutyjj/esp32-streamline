/**
 * Saving Wi-Fi from the setup network: first-join commissioning with the
 * generated admin key, or a recovery change that keeps the stored key. Both
 * the onboarding overlay and Settings → Wi-Fi go through here, so the paths
 * cannot drift.
 *
 * A first join is not a reboot wait: the device leaves for the home network
 * and this browser stays on the vanished setup AP, so polls never recover
 * here and fallback warnings would always mislead. The story is the handoff.
 */

import { signal } from '@preact/signals';
import { unlockSettings } from '../lib/adminKey';
import { ApiError, setWifi } from '../lib/api';
import { status } from './device';
import { setupKey } from './setupKey';

export interface JoinRequest {
  ssid: string;
  /** Empty keeps the stored password. */
  password: string;
  /** Bridge target set during first setup; omitted, the device keeps its own. */
  target?: { host: string; port: string };
  rememberKey: boolean;
}

/**
 * How a submitted join ended: the device acknowledged the save, or the
 * connection dropped first and nothing establishes whether it saved. A
 * rejection is not an outcome here; `joinNetwork` throws it.
 */
export type JoinOutcome = 'confirmed' | 'unconfirmed';

/** Set once a join is submitted; the owner verifies it at the station address. */
export const handoff = signal<JoinOutcome | null>(null);

/** Console address on the home network, best known before the switch. */
export function expectedHostname(): string {
  return status.value?.wifi?.hostname || 'streamline-xxxx.local';
}

/** The one handoff story every surface renders. */
export function handoffMessage(): string {
  return `${handoff.value === 'confirmed' ? 'Settings saved.' : 'The connection ended before the save could be confirmed.'} Reconnect to your own Wi-Fi, then open http://${expectedHostname()}/ to verify. Use your saved admin key at the new address. If it cannot be reached, return to the setup network and retry.`;
}

/**
 * Save Wi-Fi credentials and advance to the handoff. Commissioning is one
 * atomic write to `/api/settings/wifi` — the device reboots onto the home
 * network right after, so the initial stream target rides along here rather
 * than through a separate `/api/settings/target` call that could not complete.
 *
 * The device flushes its response before it restarts, so an HTTP error status
 * ([`ApiError`]) is a real rejection the caller must show inline. But the same
 * restart tears down the setup AP this browser is on, so the connection can
 * drop *after* a successful save — `fetch` then rejects with a transport error
 * that is not an `ApiError`. Keep that outcome unconfirmed and explain how
 * to verify the station address or return to setup and retry.
 */
export async function joinNetwork(req: JoinRequest): Promise<JoinOutcome> {
  let outcome: JoinOutcome;
  try {
    await setWifi({
      ssid: req.ssid.trim(),
      password: req.password,
      ...(req.target && {
        target_host: req.target.host.trim(),
        target_port: Number(req.target.port || status.value?.target?.target_port || 39000),
      }),
      admin_key: setupKey.value,
    });
    outcome = 'confirmed';
  } catch (err) {
    // A status came back and it was a rejection: nothing was saved, surface it.
    if (err instanceof ApiError) throw err;
    // A lost response cannot establish whether the device saved the request.
    outcome = 'unconfirmed';
  }
  // Browser custody is limited to this origin; the owner carries the saved
  // key to the station address. Recovery has no generated key to adopt.
  if (setupKey.value) unlockSettings(setupKey.value, req.rememberKey);
  handoff.value = outcome;
  return outcome;
}
