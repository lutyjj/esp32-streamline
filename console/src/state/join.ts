/**
 * First-join commissioning: save Wi-Fi credentials with the generated admin
 * key, unlock this browser, and flag the network handoff. Both the
 * onboarding overlay and the Network tab's setup-mode save go through here,
 * so the two paths cannot drift.
 *
 * A first join is not a reboot wait: the device leaves for the home network
 * and this browser stays on the vanished setup AP, so polls never recover
 * here and fallback warnings would always mislead. The story is the handoff.
 */

import { signal } from '@preact/signals';
import { unlockSettings } from '../lib/adminKey';
import { type Ack, ApiError, postForm } from '../lib/api';
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

/** True after a confirmed first join: the setup network is going away. */
export const handoff = signal(false);

/** Console address on the home network, best known before the switch. */
export function expectedHostname(): string {
  return status.value?.wifi?.hostname || 'streamline-xxxx.local';
}

/** The one handoff story every surface renders. */
export function handoffMessage(): string {
  return `The setup network disappears now — reconnect to your own Wi-Fi, then open http://${expectedHostname()}/.`;
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
 * that is not an `ApiError`. That drop is the handoff itself, not a failure:
 * assume the save took and tell the handoff story.
 */
export async function joinNetwork(req: JoinRequest): Promise<Ack> {
  let data: Ack;
  try {
    data = await postForm('/api/settings/wifi', {
      ssid: req.ssid.trim(),
      password: req.password,
      target_host: (req.targetHost ?? '').trim(),
      target_port: req.targetPort ?? String(status.value?.target?.target_port || 39000),
      admin_secret: setupKey.value,
    });
  } catch (err) {
    // A status came back and it was a rejection: nothing was saved, surface it.
    if (err instanceof ApiError) throw err;
    // No response at all — the device dropped us as it left the setup AP.
    data = { rebooting: true };
  }
  // The device reboots onto the home network; keep the key so this browser
  // can unlock it there.
  if (setupKey.value) unlockSettings(setupKey.value, req.rememberKey);
  handoff.value = true;
  return data;
}
