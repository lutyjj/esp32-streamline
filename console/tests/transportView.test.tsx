import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransportCard } from '../src/components/TransportCard';
import type { DeviceConfig, TransportStatus } from '../src/lib/api';
import { config, status } from '../src/state/device';
import { setupWizardRequested, transport } from '../src/state/transport';
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
    analog_passthrough_enabled: false,
    config_source: 'nvs',
  };
}

function buttonLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button:not(.disclosure-summary)')].map(
    (button) => button.textContent || '',
  );
}

function summaries(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.disclosure-summary')];
}

function open(host: HTMLElement, title: string): void {
  const summary = summaries(host).find((button) => button.textContent === title);
  expect(summary, `disclosure "${title}"`).toBeDefined();
  act(() => summary?.click());
}

function toggle(host: HTMLElement): HTMLInputElement | null {
  return host.querySelector<HTMLInputElement>('input[role="switch"]');
}

describe('PCM encryption journey', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
    config.value = deviceConfig(transportStatus());
    transport.revealed.value = undefined;
    setupWizardRequested.value = false;
  });

  it('routes the opt-in straight into the guided setup', () => {
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(buttonLabels(host)).toEqual([]);
    expect(summaries(host)).toEqual([]);
    expect(toggle(host)?.checked).toBe(false);

    const control = toggle(host);
    act(() => {
      if (!control) return;
      control.checked = true;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(setupWizardRequested.value).toBe(true);
  });

  it('shows a resume action and the discard exit while setup is underway', () => {
    config.value = deviceConfig(
      transportStatus({ pending_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(toggle(host)?.checked).toBe(true);
    expect(host.textContent).toContain('setting up');
    expect(host.textContent).toContain('Pending credential');
    expect(buttonLabels(host)).toContain('Resume guided setup');

    const resume = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Resume guided setup',
    );
    act(() => resume?.click());
    expect(setupWizardRequested.value).toBe(true);

    open(host, 'Recovery');
    expect(buttonLabels(host)).toContain('Discard pending credential');
    expect(buttonLabels(host)).not.toContain('Disable encryption & restart');
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

  it('keeps the steady state minimal with everything under Advanced security', () => {
    config.value = deviceConfig(
      transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
        rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
      }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.textContent).toContain('encrypted');
    expect(host.textContent).toContain('No routine action is needed.');
    expect(buttonLabels(host)).toEqual([]);
    expect(summaries(host).map((s) => s.textContent)).toEqual(['Advanced security']);

    open(host, 'Advanced security');

    expect(host.textContent).toContain('Active credential');
    expect(host.textContent).toContain('Previous credential');
    expect(buttonLabels(host)).toEqual(['Use previous credential', 'Forget previous credential']);
    expect(summaries(host).map((s) => s.textContent)).toEqual(['Advanced security', 'Recovery']);

    open(host, 'Recovery');

    expect(buttonLabels(host)).toContain('Disable encryption & restart');
    expect(buttonLabels(host)).toContain('Replace lost credential');

    open(host, 'Advanced security');
    const advanced = summaries(host).find((s) => s.textContent === 'Advanced security');
    expect(advanced?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hands credential replacement to the guided setup', () => {
    config.value = deviceConfig(
      transportStatus({ mode: 'tls-psk', active_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    open(host, 'Advanced security');
    const replace = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Replace bridge credential',
    );
    act(() => replace?.click());

    expect(setupWizardRequested.value).toBe(true);
  });

  it('confirms before disabling encryption', () => {
    config.value = deviceConfig(
      transportStatus({ mode: 'tls-psk', active_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    open(host, 'Advanced security');
    open(host, 'Recovery');
    const disable = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Disable encryption & restart',
    );
    act(() => disable?.click());

    expect(host.textContent).toContain('Switch the bridge to cleartext first');
    expect(buttonLabels(host)).toContain('Disable & restart');
    expect(buttonLabels(host)).toContain('Cancel');
  });

  it('opens the leave-encryption path when the owner unchecks the mode', () => {
    config.value = deviceConfig(
      transportStatus({ mode: 'tls-psk', active_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    );
    const host = document.createElement('div');
    render(<TransportCard />, host);

    const control = toggle(host);
    expect(control?.checked).toBe(true);
    act(() => {
      if (!control) return;
      control.checked = false;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(toggle(host)?.checked).toBe(true);
    expect(setupWizardRequested.value).toBe(false);
    expect(buttonLabels(host)).toContain('Disable encryption & restart');
  });

  it('keeps the mode control with the target and blocks it while that target is unsaved', () => {
    const host = document.createElement('div');
    render(<TransportCard targetDirty />, host);

    expect(toggle(host)?.disabled).toBe(true);
    expect(host.textContent).toContain('Save the stream target before changing encryption.');
  });
});
