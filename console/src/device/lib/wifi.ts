/**
 * A Wi-Fi save: what the owner entered, the fields it sends, and the words
 * for a field the contract's rule refuses. A blank password keeps the one the
 * device stores, so an open network is an explicit choice (`open_network`).
 */

import type { SettingsResponse, WifiSettingsRequest } from '../../generated/api';
import { WifiSettingsRequest as wifiRule } from '../../generated/rules';
import { brokenFields } from './brokenFields';

/** What the owner entered for the network the device joins. */
export interface WifiEntry {
  ssid: string;
  password: string;
  /** The owner chose an open network, one without a password. */
  open: boolean;
}

/** The request fields a Wi-Fi form shows problems on. */
export const WIFI_FIELDS = ['ssid', 'password'] as const;

export interface WifiProblem {
  field: (typeof WIFI_FIELDS)[number];
  text: string;
}

/** Whether the device holds a password a save can keep: its saved network is protected. */
export function storesWifiPassword(config: SettingsResponse | null): boolean {
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

/** What keeps an entry from being saved, per field; none means it can go. */
export function wifiProblems(entry: WifiEntry): WifiProblem[] {
  const broken = brokenFields(wifiRule, wifiRequest(entry));
  const problems: WifiProblem[] = [];
  if (broken.has('ssid')) {
    problems.push({
      field: 'ssid',
      text:
        entry.ssid.trim() === ''
          ? 'Enter the network’s name.'
          : 'A network name is at most 32 bytes, without NUL.',
    });
  }
  if (broken.has('password')) {
    problems.push({
      field: 'password',
      text: 'A Wi-Fi password has 8 to 63 characters, or is the 64-digit hexadecimal key.',
    });
  }
  return problems;
}
