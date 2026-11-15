/**
 * Handoffs: the device left this browser's network on purpose, after a Wi-Fi
 * save or a factory reset. Nothing here can answer until a new boot does, so
 * the console's last word is where to go next and how to know it worked.
 */

import type { SetupNetworkResponse, StatusResponse } from '../lib/api';
import type { Handoff } from './connection';
import { report } from './device';

/** The setup network's address, the same on every device. */
export const SETUP_ADDRESS = 'http://192.168.71.1/';

export interface HandoffStory {
  title: string;
  text: string;
  /** Where the console answers next. */
  address: string;
  /** The setup network to join, when the reset response named it. */
  setupNetwork?: SetupNetworkResponse;
}

/** Hand off to the setup network; without a response its credentials stay unknown. */
export function beginResetHandoff(setupNetwork?: SetupNetworkResponse): void {
  report({
    type: 'handoff',
    handoff: { kind: 'reset', setupNetwork: setupNetwork ?? null },
    at: Date.now(),
  });
}

/** The console's address on the home network, as the device last reported it. */
export function homeAddress(last: StatusResponse | null): string {
  return `http://${last?.wifi.hostname || 'streamline-xxxx.local'}/`;
}

export function handoffStory(handoff: Handoff, last: StatusResponse | null): HandoffStory {
  if (handoff.kind === 'reset') {
    const network = handoff.setupNetwork;
    return {
      title: 'The device is ready to set up again',
      text: network
        ? 'It left this network and opened its setup network. Join it with the password below, the same one as on the device’s label, then open the address below.'
        : 'It left this network and opened its setup network, esp32-streamline-…. Join it with the password from the device’s label or serial log, or hold the board’s first button while powering it on to open it once without one. Then open the address below.',
      address: SETUP_ADDRESS,
      ...(network && { setupNetwork: network }),
    };
  }
  const saved = handoff.confirmed
    ? `The device saved ${handoff.ssid} and is restarting to join it.`
    : `The connection ended before the device confirmed it saved ${handoff.ssid}.`;
  return {
    title: `Joining ${handoff.ssid}`,
    text: `${saved} Connect this browser to ${handoff.ssid}, open the address below and unlock with the admin key you saved. If the device cannot join, it opens its setup network again; join that, and this page says why.`,
    address: homeAddress(last),
  };
}
