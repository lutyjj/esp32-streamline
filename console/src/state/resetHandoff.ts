/**
 * The factory-reset handoff. Reset deliberately abandons this network for the
 * device's setup AP, so nothing polls the old address or claims recovery —
 * the console's last act is to point at the setup network and repeat the
 * WPA2 password the reset response carried. The password is stable device
 * identity, so it matches the device's label and flash-time log.
 */

import { signal } from '@preact/signals';
import type { SetupNetworkResponse } from '../lib/api';

/**
 * The setup-network credentials, `'unknown'` when the network dropped before
 * the response arrived, `null` while no reset happened.
 */
export const resetHandoff = signal<SetupNetworkResponse | 'unknown' | null>(null);

export function beginResetHandoff(setupNetwork?: SetupNetworkResponse): void {
  resetHandoff.value = setupNetwork ?? 'unknown';
}

/** The one handoff story the reset surfaces render. */
export function resetHandoffMessage(): string {
  const join =
    resetHandoff.value === 'unknown'
      ? 'Join the esp32-streamline-… network with the password from the device’s label or serial log (or hold the board’s first key while powering on to open it once),'
      : 'Join the network below with its password — the same one on the device’s label —';
  return `The device left this network and is broadcasting its setup Wi-Fi. ${join} then open http://192.168.71.1/ to set it up again.`;
}
