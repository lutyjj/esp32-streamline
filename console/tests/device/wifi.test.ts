import { describe, expect, it } from 'vitest';
import {
  storesWifiPassword,
  type WifiEntry,
  wifiProblems,
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

describe('wifiProblems', () => {
  it('passes a named network with a WPA2 passphrase or hexadecimal key', () => {
    expect(wifiProblems(entry({}))).toEqual([]);
    expect(wifiProblems(entry({ password: 'a'.repeat(63) }))).toEqual([]);
    expect(wifiProblems(entry({ password: 'aB'.repeat(32) }))).toEqual([]);
  });

  it('asks for a name, and refuses one longer than the contract allows', () => {
    expect(wifiProblems(entry({ ssid: '   ' }))).toEqual([
      { field: 'ssid', text: 'Enter the network’s name.' },
    ]);
    expect(wifiProblems(entry({ ssid: 'n'.repeat(33) }))).toEqual([
      { field: 'ssid', text: expect.stringContaining('32 bytes') },
    ]);
    // The contract bounds characters; the device counts bytes and refuses the rest itself.
    expect(wifiProblems(entry({ ssid: 'é'.repeat(17) }))).toEqual([]);
  });

  it('leaves a blank password to the device, which keeps a stored one or refuses', () => {
    expect(wifiProblems(entry({ password: '' }))).toEqual([]);
  });

  it('refuses a password the network cannot take', () => {
    for (const password of ['short', 'x'.repeat(64), 'a'.repeat(65), 'with\0nul!']) {
      expect(wifiProblems(entry({ password }))).toEqual([
        { field: 'password', text: expect.stringContaining('8 to 63') },
      ]);
    }
  });

  it('ignores whatever the password field holds once the network is open', () => {
    expect(wifiProblems(entry({ password: 'short', open: true }))).toEqual([]);
  });
});
