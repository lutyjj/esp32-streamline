import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportCard } from '../src/components/TransportCard';
import { deviceConfig, deviceStatus, transportStatus } from '../src/mocks/fixtures';
import { config, status } from '../src/state/device';
import { setupWizardRequested, transport } from '../src/state/transport';

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

function action(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((button) => button.textContent === label);
}

describe('PCM encryption journey', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
    config.value = deviceConfig({ transport: transportStatus() });
    transport.revealed.value = undefined;
    setupWizardRequested.value = false;
  });

  it('names encrypted audio and offers setup while cleartext', () => {
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.querySelector('.section h2')?.textContent).toBe('Encrypted audio');
    expect(host.textContent).toContain('Off');
    expect(host.textContent).toContain('Setup coordinates this device and the bridge');
  });

  it('routes the opt-in straight into the guided setup', () => {
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.querySelector('[role="switch"]')).toBeNull();
    act(() => action(host, 'Set up encryption')?.click());

    expect(setupWizardRequested.value).toBe(true);
  });

  it('shows a resume action and the discard exit while setup is underway', () => {
    config.value = deviceConfig({
      transport: transportStatus({ pending_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    });
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).toContain('Setup in progress');
    expect(host.textContent).toContain('audio is paused');
    expect(host.textContent).toContain('Pending credential');
    expect(buttonLabels(host)).toContain('Resume setup');

    const resume = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Resume setup',
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
    config.value = deviceConfig({ transport: transportStatus({ pending_key_id: keyId }) });
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
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
        rollback_key_id: 'eli1-fedcba9876543210fedcba9876543210',
      }),
    });
    const host = document.createElement('div');
    render(<TransportCard />, host);

    expect(host.textContent).toContain('Active');
    expect(host.textContent).toContain('Check the bridge for audio reception.');
    // The encouragement is only for the cleartext state.
    expect(host.querySelector('.notice')).toBeNull();
    expect(buttonLabels(host)).toEqual(['Disable encryption']);
    expect(summaries(host).map((s) => s.textContent)).toEqual(['Advanced security']);

    open(host, 'Advanced security');

    expect(host.textContent).toContain('Active credential');
    expect(host.textContent).toContain('Previous credential');
    expect(buttonLabels(host)).toEqual([
      'Disable encryption',
      'Use previous credential',
      'Forget previous credential',
    ]);
    expect(summaries(host).map((s) => s.textContent)).toEqual(['Advanced security', 'Recovery']);

    open(host, 'Recovery');

    expect(buttonLabels(host)).toContain('Disable encryption & restart');
    expect(buttonLabels(host)).toContain('Replace lost credential');

    open(host, 'Advanced security');
    const advanced = summaries(host).find((s) => s.textContent === 'Advanced security');
    expect(advanced?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hands credential replacement to the guided setup', () => {
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
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
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
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

  it('opens the leave-encryption path through an explicit action', () => {
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
    const host = document.createElement('div');
    render(<TransportCard />, host);

    act(() => action(host, 'Disable encryption')?.click());
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(setupWizardRequested.value).toBe(false);
    expect(buttonLabels(host)).toContain('Disable encryption & restart');
  });

  it('keeps the mode control with the target and blocks it while that target is unsaved', () => {
    const host = document.createElement('div');
    render(<TransportCard targetDirty />, host);

    expect(action(host, 'Set up encryption')?.disabled).toBe(true);
    expect(host.textContent).toContain('Save the stream target before changing encryption.');
  });
});

describe('destructive credential lifecycle', () => {
  it('retires the previous credential only through explicit confirmation', async () => {
    status.value = deviceStatus({ auth_required: false });
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'key-2',
        rollback_key_id: 'key-1',
      }),
    });
    const retire = vi.spyOn(transport, 'retire').mockResolvedValue({});
    const host = document.createElement('div');
    render(<TransportCard />, host);
    open(host, 'Advanced security');

    const forget = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Forget previous credential',
    );
    expect(forget).toBeDefined();
    act(() => forget?.click());
    // Armed, not executed: the first click must make no API request.
    expect(retire).not.toHaveBeenCalled();
    expect(buttonLabels(host)).toContain('Cancel');

    const confirm = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Forget it',
    );
    await act(async () => {
      confirm?.click();
    });
    expect(retire).toHaveBeenCalledOnce();
    retire.mockRestore();
  });
});
