import { getResponse } from 'msw';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeWizard } from '../src/components/BridgeWizard';
import { setTransport } from '../src/lib/api';
import { FakeDevice } from '../src/mocks/device';
import { deviceConfig, deviceStatus, transportStatus } from '../src/mocks/fixtures';
import { audioMoving, config, status } from '../src/state/device';
import { discovery } from '../src/state/discovery';
import { setupWizardRequested } from '../src/state/transport';

function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((button) => button.textContent || '');
}

function click(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  act(() => button?.click());
}

describe('BridgeWizard', () => {
  let device: FakeDevice;

  beforeEach(() => {
    device = new FakeDevice();
    setTransport(async (request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    });
    status.value = deviceStatus({ auth_required: false, target: { target_host: '' } });
    config.value = deviceConfig({ target_host: '' });
    audioMoving.value = false;
    setupWizardRequested.value = false;
    discovery.value = { phase: 'idle' };
    window.location.hash = '';
  });

  afterEach(() => {
    setTransport((request) => fetch(request));
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

  it('searches when it asks for the bridge, and Use fills the target without saving it', async () => {
    const [, second] = device.bridges;
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    click(host, 'Continue');
    await vi.waitFor(() => expect(host.textContent).toContain('bridges on your network.'));
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="Use ${second.name}"]`)?.click());

    expect(host.querySelector<HTMLInputElement>('#wiz_host')?.value).toBe(second.host);
    expect(host.querySelector<HTMLInputElement>('#wiz_port')?.value).toBe(String(second.port));
    expect(labels(host)).toContain('Save & connect');
    expect(config.value?.target_host).toBe('');
  });

  it('fills the player handoff from the last bridge used, keeping a typed address', async () => {
    config.value = deviceConfig({ target_host: '192.0.2.99', target_port: 39000 });
    const [first, second] = device.bridges;
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);
    click(host, 'Continue');
    await vi.waitFor(() => expect(host.textContent).toContain('bridges on your network.'));
    const use = (name: string) =>
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="Use ${name}"]`)?.click());
    const consoleAddress = () =>
      host.querySelector<HTMLInputElement>('input[type="url"]')?.value ?? null;
    const back = () => click(host, 'Back');

    use(first.name);
    use(second.name);
    // Matching the saved target skips the save, so Continue reaches the handoff.
    act(() => {
      config.value = deviceConfig({ target_host: second.host, target_port: second.port });
    });
    click(host, 'Continue');
    expect(consoleAddress()).toBe(`http://${second.host}:${second.http_port}/`);

    const typed = host.querySelector<HTMLInputElement>('input[type="url"]');
    act(() => {
      if (!typed) return;
      typed.value = 'https://ha.example/bridge';
      typed.dispatchEvent(new Event('input', { bubbles: true }));
    });
    back();
    // Returning to the step searches again.
    await vi.waitFor(() =>
      expect(host.querySelector(`[aria-label="Use ${first.name}"]`)).not.toBeNull(),
    );
    use(first.name);
    act(() => {
      config.value = deviceConfig({ target_host: first.host, target_port: first.port });
    });
    click(host, 'Continue');
    expect(consoleAddress()).toBe('https://ha.example/bridge');
  });

  it('skips the save when the target already matches and narrates Sending', () => {
    config.value = deviceConfig({ target_host: '192.0.2.20', target_port: 39000 });
    status.value = deviceStatus({ auth_required: false, metrics: { playing: true } });
    audioMoving.value = true;
    const host = document.createElement('div');
    render(<BridgeWizard onClose={() => {}} />, host);

    click(host, 'Continue');

    expect(labels(host)).not.toContain('Save & connect');
    expect(host.textContent).toContain(
      'The device is sending audio. Check reception in the bridge console.',
    );
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
    expect(host.textContent).toContain('Connect your player');

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

    expect(host.textContent).toContain('Audio to the bridge is encrypted.');
    expect(labels(host)).toContain('Done');
    expect(labels(host)).not.toContain('Set up encryption');
  });
});
