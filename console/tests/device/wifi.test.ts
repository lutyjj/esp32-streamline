import { describe, expect, it } from 'vitest';
import {
  passwordProblem,
  ssidProblem,
  storesWifiPassword,
  type WifiEntry,
  wifiRequest,
} from '../../src/device/lib/wifi';
import { deviceConfig } from '../../src/device/mocks/fixtures';

const entry = (over: Partial<WifiEntry>): WifiEntry => ({
  ssid: 'home',
  password: 'correct horse',
  open: false,
  ...over,
});

describe('wifiRequest', () => {
  it('sends no password for an open network, whatever the field holds', () => {
    expect(
      wifiRequest(entry({ ssid: ' home ', password: 'typed before ticking', open: true })),
    ).toEqual({ ssid: 'home', password: '', open_network: true });
  });

  it('sends the typed password, or a blank one that keeps the stored password', () => {
    expect(wifiRequest(entry({}))).toEqual({
      ssid: 'home',
      password: 'correct horse',
      open_network: false,
    });
    expect(wifiRequest(entry({ password: '' })).password).toBe('');
  });
});

describe('storesWifiPassword', () => {
  it('holds only for a saved protected network', () => {
    expect(storesWifiPassword(deviceConfig())).toBe(true);
    expect(storesWifiPassword(deviceConfig({ open_network: true }))).toBe(false);
    expect(storesWifiPassword(deviceConfig({ ssid: '' }))).toBe(false);
    expect(storesWifiPassword(null)).toBe(false);
  });
});

describe('ssidProblem', () => {
  it('passes a name, trimming space', () => {
    expect(ssidProblem(' home ')).toBeNull();
  });

  it('asks for a name, and refuses one longer than the contract allows', () => {
    expect(ssidProblem('   ')).toBe('Enter the network’s name.');
    expect(ssidProblem('n'.repeat(33))).toContain('32 bytes');
    // The contract bounds characters; the device counts bytes and refuses the rest itself.
    expect(ssidProblem('é'.repeat(17))).toBeNull();
  });
});

describe('passwordProblem', () => {
  it('passes a WPA2 passphrase or hexadecimal key', () => {
    expect(passwordProblem('correct horse')).toBeNull();
    expect(passwordProblem('a'.repeat(63))).toBeNull();
    expect(passwordProblem('aB'.repeat(32))).toBeNull();
  });

  it('leaves a blank password to the device, which keeps a stored one or refuses', () => {
    expect(passwordProblem('')).toBeNull();
  });

  it('refuses a password the network cannot take', () => {
    for (const password of ['short', 'x'.repeat(64), 'a'.repeat(65), 'with\0nul!']) {
      expect(passwordProblem(password), password).toContain('8 to 63');
    }
  });
});
