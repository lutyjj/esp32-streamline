/**
 * A Wi-Fi save: what the owner entered, what keeps it from going, and the
 * fields it sends. A blank password keeps the one the device stores, so an
 * open network is an explicit choice (`open_network`), never an empty field.
 * The limits are the ones the contract's Wi-Fi fields describe.
 */

import type { SettingsResponse } from './api';

/** What the owner entered for the network the device joins. */
export interface WifiEntry {
  ssid: string;
  password: string;
  /** The owner chose an open network, one without a password. */
  open: boolean;
}

/** The request fields that decide how the device authenticates to the network. */
export interface WifiCredentials {
  password: string;
  open_network: boolean;
}

export interface WifiProblem {
  field: 'ssid' | 'password';
  text: string;
}

const SSID_MAX_BYTES = 32;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A WPA2 passphrase of 8 to 63 bytes, or the 64-digit hexadecimal key itself. */
function wpa2Password(password: string): boolean {
  if (password.includes('\0')) return false;
  const bytes = utf8Bytes(password);
  return (bytes >= 8 && bytes <= 63) || /^[0-9a-fA-F]{64}$/.test(password);
}

/** Whether the device holds a password a save can keep: its saved network is protected. */
export function storesWifiPassword(config: SettingsResponse | null): boolean {
  return Boolean(config?.ssid) && config?.open_network === false;
}

/** What keeps an entry from being saved, per field; none means it can go. */
export function wifiProblems(entry: WifiEntry, storedPassword: boolean): WifiProblem[] {
  const problems: WifiProblem[] = [];
  const ssid = entry.ssid.trim();
  if (ssid === '') {
    problems.push({ field: 'ssid', text: 'Enter the network’s name.' });
  } else if (ssid.includes('\0') || utf8Bytes(ssid) > SSID_MAX_BYTES) {
    problems.push({
      field: 'ssid',
      text: `A network name holds at most ${SSID_MAX_BYTES} bytes, and this one has ${utf8Bytes(ssid)}.`,
    });
  }
  if (entry.open) return problems;
  if (entry.password === '') {
    if (!storedPassword) {
      problems.push({
        field: 'password',
        text: 'Enter the network’s password, or choose an open network.',
      });
    }
  } else if (!wpa2Password(entry.password)) {
    problems.push({
      field: 'password',
      text: 'A Wi-Fi password has 8 to 63 characters, or is the 64-digit hexadecimal key.',
    });
  }
  return problems;
}

/**
 * The credentials a Wi-Fi save sends. An open network sends no password; a
 * protected one sends the typed password, or blank to keep a stored one.
 * Throws when a protected network has neither.
 */
export function wifiCredentials(
  open: boolean,
  password: string,
  storedPassword: boolean,
): WifiCredentials {
  if (open) return { password: '', open_network: true };
  if (!password && !storedPassword) {
    throw new Error('Enter the Wi-Fi password, or mark the network as open');
  }
  return { password, open_network: false };
}
