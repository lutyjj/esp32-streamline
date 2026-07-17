/**
 * The factory-reset handoff. Reset deliberately abandons this network for the
 * device's setup AP, so nothing polls the old address or claims recovery —
 * the console's last act is to point at the setup network.
 */

import { signal } from '@preact/signals';

export const resetHandoff = signal(false);

export function beginResetHandoff(): void {
  resetHandoff.value = true;
}

/** The one handoff story the reset surfaces render. */
export function resetHandoffMessage(): string {
  return (
    'The device left this network and is broadcasting its setup Wi-Fi. ' +
    'Join the esp32-streamline-… network, then open http://192.168.71.1/ to set it up again.'
  );
}
