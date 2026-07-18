import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeWizard } from '../src/components/BridgeWizard';
import { deviceConfig, deviceStatus, transportStatus } from '../src/mocks/fixtures';
import { config, packetsMoving, status } from '../src/state/device';
import { setupWizardRequested } from '../src/state/transport';

function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((button) => button.textContent || '');
}

function click(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  act(() => button?.click());
}

describe('BridgeWizard', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false, target: { target_host: '' } });
    config.value = deviceConfig({ target_host: '' });
    packetsMoving.value = false;
    setupWizardRequested.value = false;
    window.location.hash = '';
  });

  it('names the install step for the chosen bridge', () => {
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('install ESP32 StreamLine Bridge');

    const docker = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    act(() => {
      docker.checked = true;
      docker.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(host.textContent).toContain('Run the bridge container');
  });

  it('asks to save the target when no bridge is configured yet', () => {
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    click(host, 'Continue');

    expect(labels(host)).toContain('Save & connect');
    expect(labels(host)).not.toContain('Continue');
  });

  it('skips the save when the target already matches and narrates Sending', () => {
    config.value = deviceConfig({ target_host: '192.0.2.20', target_port: 39000 });
    status.value = deviceStatus({ auth_required: false, metrics: { playing: true } });
    packetsMoving.value = true;
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    click(host, 'Continue');

    expect(labels(host)).not.toContain('Save & connect');
    expect(host.textContent).toContain('Bridge tile reads Sending');
  });

  it('continues straight into the guided encryption setup', () => {
    config.value = deviceConfig({ target_host: '192.0.2.20' });
    let closed = false;
    const host = document.createElement('div');
    render(
      <BridgeWizard
        onClose={() => {
          closed = true;
        }}
      />,
      host,
    );

    click(host, 'Continue');
    click(host, 'Continue');
    expect(host.textContent).toContain('Encrypt the connection?');

    click(host, 'Set up encryption');

    expect(setupWizardRequested.value).toBe(true);
    expect(closed).toBe(true);
  });

  it('reports encryption already active and only offers Done', () => {
    config.value = deviceConfig({
      target_host: '192.0.2.20',
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    click(host, 'Continue');
    click(host, 'Continue');

    expect(host.textContent).toContain('Encryption is on');
    expect(labels(host)).toContain('Done');
    expect(labels(host)).not.toContain('Set up encryption');
  });
});
