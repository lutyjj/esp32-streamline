import { describe, expect, it } from 'vitest';
import {
  storesWifiPassword,
  type WifiEntry,
  wifiCredentials,
  wifiProblems,
} from '../../src/device/lib/wifi';
import { deviceConfig } from '../../src/device/mocks/fixtures';

describe('wifiCredentials', () => {
  it('sends no password for an open network, whatever the field holds', () => {
    expect(wifiCredentials(true, 'typed before ticking', true)).toEqual({
      password: '',
      open_network: true,
    });
  });

  it('sends a typed password for a protected network', () => {
    expect(wifiCredentials(false, 'correct horse', false)).toEqual({
      password: 'correct horse',
      open_network: false,
    });
  });

  it('keeps a stored password with a blank field', () => {
    expect(wifiCredentials(false, '', true)).toEqual({ password: '', open_network: false });
  });

  it('refuses a blank password when the device has none to keep', () => {
    // First setup, or leaving an open network for a protected one: blank must
    // never quietly mean open.
    expect(() => wifiCredentials(false, '', false)).toThrow(/Enter the Wi-Fi password/);
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
  const entry = (over: Partial<WifiEntry>): WifiEntry => ({
    ssid: 'home',
    password: 'correct horse',
    open: false,
    ...over,
  });

  it('passes a named network with a WPA2 passphrase or hexadecimal key', () => {
    expect(wifiProblems(entry({}), false)).toEqual([]);
    expect(wifiProblems(entry({ password: 'a'.repeat(63) }), false)).toEqual([]);
    expect(wifiProblems(entry({ password: 'aB'.repeat(32) }), false)).toEqual([]);
  });

  it('asks for a name, and counts a name’s limit in bytes, not characters', () => {
    expect(wifiProblems(entry({ ssid: '   ' }), false)).toEqual([
      { field: 'ssid', text: expect.stringContaining('name') },
    ]);
    // Sixteen two-byte letters fill the 32 bytes; one more is over.
    expect(wifiProblems(entry({ ssid: 'é'.repeat(16) }), false)).toEqual([]);
    expect(wifiProblems(entry({ ssid: 'é'.repeat(17) }), false)).toEqual([
      { field: 'ssid', text: expect.stringContaining('this one has 34') },
    ]);
  });

  it('refuses a blank password unless one is stored or the network is open', () => {
    expect(wifiProblems(entry({ password: '' }), false)).toEqual([
      { field: 'password', text: expect.stringContaining('choose an open network') },
    ]);
    expect(wifiProblems(entry({ password: '' }), true)).toEqual([]);
    expect(wifiProblems(entry({ password: '', open: true }), false)).toEqual([]);
  });

  it('refuses a password the network cannot take', () => {
    for (const password of ['short', 'x'.repeat(64), 'a'.repeat(65), 'with\0nul!']) {
      expect(wifiProblems(entry({ password }), false)).toEqual([
        { field: 'password', text: expect.stringContaining('8 to 63') },
      ]);
    }
  });

  it('ignores whatever the password field holds once the network is open', () => {
    expect(wifiProblems(entry({ password: 'short', open: true }), false)).toEqual([]);
  });
});
