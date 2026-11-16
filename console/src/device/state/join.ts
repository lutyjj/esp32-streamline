/**
 * Saving Wi-Fi from the setup network: first contact, which sends the admin
 * key the owner kept along with the network, or a recovery change that keeps
 * the stored key. Either way the device leaves for another network, so the
 * story continues as a handoff, never as a restart wait.
 */

import { setWifi } from '../../generated/api';
import { ApiError } from '../../shared/http';
import { unlockSettings } from '../lib/adminKey';
import { type WifiEntry, type WifiProblem, wifiCredentials, wifiProblems } from '../lib/wifi';
import { report } from './device';
import { setupKey } from './setupKey';

/**
 * How a submitted join ended: the device acknowledged the save, or the
 * connection dropped first and nothing establishes whether it saved. A
 * refusal is not an outcome here; `joinNetwork` throws it.
 */
export type JoinOutcome = 'confirmed' | 'unconfirmed';

export type JoinBlock = WifiProblem | { field: 'key'; text: string };

/**
 * What keeps a join from going. First contact also waits for the owner to
 * confirm the generated key is kept outside this console: the device adopts
 * it in the same write, and this browser cannot carry it to the home address.
 */
export function joinBlocks(
  entry: WifiEntry,
  { storedPassword, keySaved }: { storedPassword: boolean; keySaved: boolean },
): JoinBlock[] {
  const blocks: JoinBlock[] = wifiProblems(entry, storedPassword);
  if (setupKey.value !== '' && !keySaved) {
    blocks.push({ field: 'key', text: 'Confirm the admin key is saved outside this console.' });
  }
  return blocks;
}

/**
 * Save the network and hand off. The device flushes its response before it
 * restarts, so an HTTP error ([`ApiError`]) is a refusal the caller shows
 * beside the form. The same restart tears down the setup network this browser
 * is on, so the connection can drop after a successful save: that outcome
 * stays unconfirmed.
 */
export async function joinNetwork(entry: WifiEntry, storedPassword: boolean): Promise<JoinOutcome> {
  const ssid = entry.ssid.trim();
  let outcome: JoinOutcome;
  try {
    await setWifi({
      ssid,
      ...wifiCredentials(entry.open, entry.password, storedPassword),
      admin_key: setupKey.value,
    });
    outcome = 'confirmed';
  } catch (error) {
    if (error instanceof ApiError) throw error;
    outcome = 'unconfirmed';
  }
  // Should the join fail, the device returns to this setup network, and the
  // owner fixes the network without typing the key again.
  if (setupKey.value) unlockSettings(setupKey.value, false);
  report({
    type: 'handoff',
    handoff: { kind: 'join', ssid, confirmed: outcome === 'confirmed' },
    at: Date.now(),
  });
  return outcome;
}
