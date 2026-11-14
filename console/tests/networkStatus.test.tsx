import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { SystemTab } from '../src/components/SystemTab';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { setTransport } from '../src/lib/api';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { audioMoving, config, status, unreachable } from '../src/state/device';
import { handoff } from '../src/state/join';
import { rebootWait } from '../src/state/rebootWait';

const host = document.createElement('div');
afterEach(() => {
  render(null, host);
  unreachable.value = false;
  status.value = null;
  config.value = null;
  handoff.value = null;
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

it('does not describe a failed poll as quiet audio or connected Wi-Fi', () => {
  status.value = deviceStatus({ auth_required: false });
  config.value = deviceConfig({ target_host: '192.0.2.20' });
  audioMoving.value = true;
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

it('changes Wi-Fi in recovery through the handoff, keeping the target and key', async () => {
  status.value = deviceStatus({
    mode: 'recovery',
    wifi: {
      ssid: 'Study Wi-Fi',
      status: 'ap',
      ap_ip: '192.168.71.1',
      join_failure: 'credentials-rejected',
    },
    diagnostics: {
      last_fallback: 'v0.9.0: Wi-Fi station connection failed (credentials-rejected)',
    },
  });
  config.value = deviceConfig({ ssid: 'Study Wi-Fi', target_host: '192.0.2.20' });
  unlockSettings('a'.repeat(48), false);
  let body = '';
  setTransport(async (request) => {
    body = await request.text();
    return new Response('{"ok":true,"rebooting":true}', { status: 200 });
  });
  await act(async () => render(<NetworkTab section="wifi" onSetupBridge={() => {}} />, host));
  expect(host.textContent).toContain('Not connected. Change the details below');
  expect(host.textContent).toContain('Startup report: v0.9.0: Wi-Fi station connection failed');
  expect(host.textContent).not.toContain('Not configured yet');

  const save = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === 'Save & restart',
  );
  await act(async () => save?.click());
  await vi.waitFor(() => expect(handoff.value).toBe('confirmed'));

  const fields = new URLSearchParams(body);
  expect(fields.get('ssid')).toBe('Study Wi-Fi');
  expect(fields.get('password')).toBe('');
  expect(fields.has('target_host')).toBe(false);
  // This browser stays on the setup network the device leaves; no reboot wait.
  expect(rebootWait.value).toBeNull();
});
