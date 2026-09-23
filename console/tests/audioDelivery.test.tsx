import { render } from 'preact';
import { afterEach, expect, it } from 'vitest';
import { AudioDelivery } from '../src/components/AudioDelivery';
import { deviceStatus } from '../src/mocks/fixtures';
import { packetsMoving, status, unreachable } from '../src/state/device';

afterEach(() => {
  status.value = null;
  packetsMoving.value = false;
  unreachable.value = false;
});
it('never presents historical packet movement as a live transmission', () => {
  status.value = deviceStatus();
  packetsMoving.value = true;
  unreachable.value = true;
  const host = document.createElement('div');
  render(<AudioDelivery onSetupBridge={() => {}} />, host);
  expect(host.textContent).toContain('Device unavailable');
  expect(host.textContent).not.toContain('Sending audio');
  expect(host.querySelector('button')).toBeNull();
  render(null, host);
});
it('explains an external streaming pause with a resume action', () => {
  status.value = deviceStatus({ stream: { enabled: false } });
  const host = document.createElement('div');
  render(<AudioDelivery onSetupBridge={() => {}} />, host);
  expect(host.textContent).toContain('The input meter stays live.');
  expect(host.querySelector('button')?.textContent).toBe('Resume');
  render(null, host);
});
