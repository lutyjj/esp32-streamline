/**
 * A Wi-Fi save: what the owner entered, the fields it sends, and the words
 * for a value the contract's rule refuses. A blank password keeps the one the
 * device stores, so an open network is an explicit choice (`open_network`).
 */

import * as v from 'valibot';
import type { SettingsResponse, WifiSettingsRequest } from '../../generated/api';
import { WifiSettingsRequest as wifiRule } from '../../generated/rules';

/** What the owner entered for the network the device joins. */
export interface WifiEntry {
  ssid: string;
  password: string;
  /** The owner chose an open network, one without a password. */
  open: boolean;
}

/** The request fields a Wi-Fi form names its fields after. */
export const WIFI_FIELDS = ['ssid', 'password'] as const;

/** Whether the device holds a password a save can keep: its saved network is protected. */
export function storesWifiPassword(config: SettingsResponse | null | undefined): boolean {
  return Boolean(config?.ssid) && config?.open_network === false;
}

/** The network fields a save sends. An open network sends no password. */
export function wifiRequest(
  entry: WifiEntry,
): Pick<WifiSettingsRequest, 'ssid' | 'password' | 'open_network'> {
  return {
    ssid: entry.ssid.trim(),
    password: entry.open ? '' : entry.password,
    open_network: entry.open,
  };
}

/** Why the contract refuses `value` as the network's name, or null. */
export function ssidProblem(value: string): string | null {
  const ssid = value.trim();
  if (v.is(wifiRule.entries.ssid, ssid)) return null;
  return ssid === ''
    ? 'Enter the network’s name.'
    : 'A network name is at most 32 bytes, without NUL.';
}

/** Why the contract refuses `value` as the password; a blank one is the device's to judge. */
export function passwordProblem(value: string): string | null {
  return v.is(wifiRule.entries.password, value)
    ? null
    : 'A Wi-Fi password has 8 to 63 characters, or is the 64-digit hexadecimal key.';
}
