/**
 * First-join commissioning: save Wi-Fi credentials with the generated admin
 * key, unlock this browser, and flag the network handoff. Both the
 * onboarding overlay and the Connections page's setup-mode save go through here,
 * so the two paths cannot drift.
 *
 * A first join is not a reboot wait: the device leaves for the home network
 * and this browser stays on the vanished setup AP, so polls never recover
 * here and fallback warnings would always mislead. The story is the handoff.
 */

import { signal } from '@preact/signals';
import { unlockSettings } from '../lib/adminKey';
import { type Ack, ApiError, setWifi } from '../lib/api';
import { status } from './device';
import { setupKey } from './setupKey';

export interface JoinRequest {
  ssid: string;
  password: string;
  /** Optional bridge target, when the user filled it in during setup. */
  targetHost?: string;
  targetPort?: string;
  rememberKey: boolean;
}

/** A join was submitted; the owner must verify it at the station address. */
export const handoff = signal(false);
export const handoffConfirmed = signal(false);

/** Console address on the home network, best known before the switch. */
export function expectedHostname(): string {
  return status.value?.wifi?.hostname || 'streamline-xxxx.local';
}

/** The one handoff story every surface renders. */
export function handoffMessage(): string {
  return `${handoffConfirmed.value ? 'Settings saved.' : 'The connection ended before the save could be confirmed.'} Reconnect to your own Wi-Fi, then open http://${expectedHostname()}/ to verify. Use your saved admin key at the new address. If it cannot be reached, return to the setup network and retry.`;
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
export async function joinNetwork(req: JoinRequest): Promise<Ack> {
  handoffConfirmed.value = false;
  let data: Ack;
  try {
    data = await setWifi({
      ssid: req.ssid.trim(),
      password: req.password,
      target_host: (req.targetHost ?? '').trim(),
      target_port: Number(req.targetPort ?? status.value?.target?.target_port ?? 39000),
      admin_key: setupKey.value,
    });
    handoffConfirmed.value = true;
  } catch (err) {
    // A status came back and it was a rejection: nothing was saved, surface it.
    if (err instanceof ApiError) throw err;
    // A lost response cannot establish whether the device saved the request.
    data = { rebooting: true };
  }
  // Browser custody is limited to this origin; the owner carries the saved
  // key to the station address.
  if (setupKey.value) unlockSettings(setupKey.value, req.rememberKey);
  handoff.value = true;
  return data;
}
