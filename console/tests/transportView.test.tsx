import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransportCard } from '../src/components/TransportCard';
import type { DeviceConfig, TransportStatus } from '../src/lib/api';
import { config, status } from '../src/state/device';
import { transport } from '../src/state/transport';
import { deviceStatus } from './fixtures';

function transportStatus(overrides: Partial<TransportStatus> = {}): TransportStatus {
  return {
    contract_version: 1,
    mode: 'cleartext',
    active_key_id: null,
    pending_key_id: null,
    pending_verified: false,
    rollback_key_id: null,
    ...overrides,
  };
}

function deviceConfig(transport: TransportStatus): DeviceConfig {
  return {
    device_name: '',
    ssid: 'home',
    target_host: '192.0.2.20',
    target_port: 39000,
    transport,
    auto_update_schedule: 'daily',
    input_line: 2,
    input_gain: 0,
    adc_attenuation_db: 9,
    config_source: 'nvs',
  };
}

function buttonLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((button) => button.textContent || '');
}

describe('PCM encryption journey', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
    config.value = deviceConfig(transportStatus());
    transport.revealed.value = undefined;
  });

  it('keeps encryption controls behind one opt-in action', () => {
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(buttonLabels(host)).toEqual([]);
    expect(host.textContent).not.toContain('Generate encrypted key');

    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => {
      if (!toggle) return;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(host.textContent).toContain('Step 1 of 3 · Create a bridge credential');
    expect(buttonLabels(host)).toEqual(['Generate bridge credential']);
  });

  it('shows only the valid provisioning action', () => {
    config.value = deviceConfig(
      transportStatus({ pending_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.textContent).toContain('Step 2 of 3 · Switch the bridge and verify');
    expect(buttonLabels(host)).toEqual(['Verify with bridge', 'Recovery options']);
  });

  it('masks the one-time PSK until the owner explicitly reveals it', () => {
    const keyId = 'eli1-0123456789abcdef0123456789abcdef';
    const psk = '01'.repeat(32);
    config.value = deviceConfig(transportStatus({ pending_key_id: keyId }));
    transport.revealed.value = { contract_version: 1, key_id: keyId, psk, recovery: false };
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.textContent).not.toContain(psk);
    expect(host.textContent).toContain('Anyone with this PSK can impersonate the device');

    const reveal = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reveal PSK',
    );
    act(() => reveal?.click());

    expect(host.textContent).toContain(psk);
  });

  it('separates rotation decisions from collapsed recovery exits', () => {
    config.value = deviceConfig(
      transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
        rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
      }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.textContent).toContain('No immediate action is required.');
    expect(host.textContent).not.toContain('Rotation complete');
    expect(buttonLabels(host)).toEqual(['Advanced security']);
    expect(host.querySelector('.transport-fallback')).toBeNull();

    const advanced = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Advanced security',
    );
    act(() => advanced?.click());

    expect(buttonLabels(host)).toContain('Use previous credential');
    expect(buttonLabels(host)).toContain('Forget previous credential');

    const recovery = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Recovery options',
    );
    act(() => recovery?.click());

    expect(host.querySelector('.transport-fallback')).not.toBeNull();
    expect(buttonLabels(host)).toContain('Disable encryption & restart');
    expect(buttonLabels(host)).toContain('Replace lost credential');

    const hideAdvanced = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Hide advanced security',
    );
    act(() => hideAdvanced?.click());

    expect(host.querySelector('.transport-fallback')).toBeNull();
    expect(buttonLabels(host)).toEqual(['Advanced security']);
  });

  it('keeps the mode control with the target and blocks it while that target is unsaved', () => {
    const host = document.createElement('div');
    render(<TransportCard targetDirty />, host);

    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(host.textContent).toContain('Save the stream target before changing encryption.');
  });
});
