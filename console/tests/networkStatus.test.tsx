import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { config, packetsMoving, status, unreachable } from '../src/state/device';

const host = document.createElement('div');
afterEach(() => {
  render(null, host);
  unreachable.value = false;
  status.value = null;
  config.value = null;
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
