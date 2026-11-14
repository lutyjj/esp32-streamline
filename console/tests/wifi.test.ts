import { describe, expect, it } from 'vitest';
import { storesWifiPassword, wifiCredentials } from '../src/lib/wifi';
import { deviceConfig } from '../src/mocks/fixtures';

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
