/**
 * The factory-reset handoff. Reset deliberately abandons this network for the
 * device's setup AP, so nothing polls the old address or claims recovery —
 * the console's last act is to point at the setup network and repeat the
 * WPA2 password the reset response carried. The password is stable device
 * identity, so it matches the device's label and flash-time log.
 */

import type { SetupNetworkResponse } from '../lib/api';
import { report } from './device';

/** Hand off to the setup network; without a response its credentials stay unknown. */
export function beginResetHandoff(setupNetwork?: SetupNetworkResponse): void {
  report({
    type: 'handoff',
    handoff: { kind: 'reset', setupNetwork: setupNetwork ?? null },
    at: Date.now(),
  });
}

/** The one handoff story the reset surfaces render. */
export function resetHandoffMessage(setupNetwork: SetupNetworkResponse | null): string {
  const join =
    setupNetwork === null
      ? 'Join the esp32-streamline-… network with the password from the device’s label or serial log (or hold the board’s first key while powering on to open it once),'
      : 'Join the network below with its password — the same one on the device’s label —';
  return `The device left this network and is broadcasting its setup Wi-Fi. ${join} then open http://192.168.71.1/ to set it up again.`;
}
