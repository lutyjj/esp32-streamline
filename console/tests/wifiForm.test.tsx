import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { setTransport } from '../src/lib/api';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { config, status } from '../src/state/device';
import { handoff } from '../src/state/join';
import { rebootWait } from '../src/state/rebootWait';

const host = document.createElement('div');
afterEach(() => {
  render(null, host);
  status.value = null;
  config.value = null;
  handoff.value = null;
  rebootWait.value = null;
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

/** Render Settings → Wi-Fi unlocked and capture the body of every write. */
async function wifiForm(): Promise<string[]> {
  unlockSettings('a'.repeat(48), false);
  const bodies: string[] = [];
  setTransport(async (request) => {
    bodies.push(await request.text());
    return new Response('{"ok":true,"rebooting":true}', { status: 200 });
  });
  await act(async () => render(<NetworkTab section="wifi" onSetupBridge={() => {}} />, host));
  return bodies;
}

function element<T extends Element>(found: T | null | undefined, name: string): T {
  if (!found) throw new Error(`${name} missing`);
  return found;
}
const openChoice = () =>
  element(host.querySelector<HTMLInputElement>('label.field-check input'), 'open-network choice');
const passwordInput = () =>
  element(host.querySelector<HTMLInputElement>('#password'), 'password field');
async function chooseOpen(checked: boolean): Promise<void> {
  await act(async () => {
    openChoice().checked = checked;
    openChoice().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const button = (name: string) =>
  Array.from(host.querySelectorAll('button')).find((element) => element.textContent === name);

it('switches a protected network to open without sending a password', async () => {
  status.value = deviceStatus();
  config.value = deviceConfig();
  const bodies = await wifiForm();
  expect(openChoice().checked).toBe(false);

  await chooseOpen(true);
  expect(passwordInput().disabled).toBe(true);
  expect(button('Change')).toBeUndefined();
  expect(host.textContent).toContain('Anyone in range can join an open network');

  await act(async () => button('Save & restart')?.click());
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  const fields = new URLSearchParams(bodies[0]);
  expect(fields.get('open_network')).toBe('true');
  expect(fields.get('password')).toBe('');
});

it('asks for a password before leaving a saved open network', async () => {
  // Recovery on a saved open network: the choice starts ticked, and unticking
  // it has no stored password to keep, so a blank field must not save.
  status.value = deviceStatus({
    mode: 'recovery',
    wifi: { ssid: 'Cafe', status: 'ap', ap_ip: '192.168.71.1', join_failure: 'network-not-found' },
  });
  config.value = deviceConfig({ ssid: 'Cafe', open_network: true });
  const bodies = await wifiForm();
  expect(openChoice().checked).toBe(true);

  await chooseOpen(false);
  expect(passwordInput().disabled).toBe(false);
  expect(button('Change')).toBeUndefined();
  await act(async () => button('Save & restart')?.click());
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Enter the Wi-Fi password, or mark the network as open'),
  );
  expect(bodies).toHaveLength(0);

  await act(async () => {
    passwordInput().value = 'correct horse';
    passwordInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save & restart')?.click());
  await vi.waitFor(() => expect(handoff.value).toBe('confirmed'));
  const fields = new URLSearchParams(bodies[0]);
  expect(fields.get('open_network')).toBe('false');
  expect(fields.get('password')).toBe('correct horse');
});
