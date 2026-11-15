/**
 * How a Wi-Fi save says to join the network. A blank password keeps the one
 * the device stores, so an open network is an explicit choice
 * (`open_network`), never an empty field.
 */

import type { SettingsResponse } from './api';

/** The request fields that decide how the device authenticates to the network. */
export interface WifiCredentials {
  password: string;
  open_network: boolean;
}

/** Whether the device holds a password a save can keep: its saved network is protected. */
export function storesWifiPassword(config: SettingsResponse | null): boolean {
  return Boolean(config?.ssid) && config?.open_network === false;
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
