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
import { type Ack, postForm } from '../lib/api';
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
 * Save and advance only on the device's confirmation: the response is
 * flushed before the restart, so a thrown error means nothing was saved and
 * the caller shows it where the user can act.
 */
export async function joinNetwork(req: JoinRequest): Promise<Ack> {
  const data = await postForm('/api/settings/network', {
    ssid: req.ssid.trim(),
    password: req.password,
    target_host: (req.targetHost ?? '').trim(),
    target_port: req.targetPort ?? String(status.value?.target?.target_port || 39000),
    admin_secret: setupKey.value,
  });
  // The device reboots onto the home network; keep the key so this browser
  // can unlock it there.
  if (setupKey.value) unlockSettings(setupKey.value, req.rememberKey);
  handoff.value = true;
  return data;
}
