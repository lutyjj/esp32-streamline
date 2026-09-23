import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { SystemTab } from '../src/components/SystemTab';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { config, packetsMoving, status, unreachable } from '../src/state/device';

const host = document.createElement('div');
afterEach(() => {
  render(null, host);
  unreachable.value = false;
  status.value = null;
  config.value = null;
  forgetAdminKey();
});

it('does not describe a failed poll as quiet audio or connected Wi-Fi', () => {
  status.value = deviceStatus({ auth_required: false });
  config.value = deviceConfig({ target_host: '192.0.2.20' });
  packetsMoving.value = true;
  render(<NetworkTab onSetupBridge={() => {}} />, host);
  act(() => {
    unreachable.value = true;
  });
  expect(host.textContent).toContain('connection unavailable');
  expect(host.textContent).not.toContain('idle');
  render(<NetworkTab section="wifi" onSetupBridge={() => {}} />, host);
  expect(host.textContent).toContain('Connection details are last known');
  expect(host.textContent).not.toContain('Connected to');
});

it('uses a fresh disconnected Wi-Fi state even when a network name remains', () => {
  status.value = deviceStatus({ auth_required: false, wifi: { status: 'disconnected' } });
  config.value = deviceConfig();
  render(<NetworkTab section="wifi" onSetupBridge={() => {}} />, host);
  expect(host.textContent).toContain('Wi-Fi disconnected');
  expect(host.textContent).not.toContain('Connected to');
});

it('preserves the unsaved target guard across settings navigation', async () => {
  status.value = deviceStatus();
  config.value = deviceConfig({ target_host: '192.0.2.20' });
  unlockSettings('a'.repeat(48), false);
  window.location.hash = '#/settings/bridge';
  await act(async () => render(<SystemTab onSetupBridge={() => {}} />, host));
  const target = host.querySelector<HTMLInputElement>('#target_host')!;
  await act(async () => {
    target.value = '192.0.2.21';
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  async function navigate(hash: string) {
    await act(async () => {
      window.location.hash = hash;
      window.dispatchEvent(new Event('hashchange'));
    });
  }
  await navigate('#/settings/security');
  const encryption = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Set up encryption',
    );
  expect(encryption()?.disabled).toBe(true);
  expect(host.textContent).toContain('Save the stream target before changing encryption.');
  await navigate('#/settings/bridge');
  await act(async () => {
    target.value = '192.0.2.20';
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await navigate('#/settings/security');
  expect(encryption()?.disabled).toBe(false);
});
