import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it } from 'vitest';
import { AudioDelivery } from '../src/components/AudioDelivery';
import { BridgeWizard } from '../src/components/BridgeWizard';
import { setTransport } from '../src/lib/api';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { audioMoving, config, refresh, status, unreachable } from '../src/state/device';

afterEach(() => {
  status.value = null;
  audioMoving.value = false;
  unreachable.value = false;
  config.value = null;
  setTransport((request) => fetch(request));
});
it('keeps quiet input distinct in delivery and hookup narration while silence records flow', async () => {
  let records = 100;
  let bytes = 0;
  let playing = false;
  setTransport(
    async () =>
      new Response(
        JSON.stringify(
          deviceStatus({
            metrics: {
              packets_total: records,
              silence_packets_total: records,
              bytes_total: bytes,
              playing,
            },
          }),
        ),
      ),
  );
  config.value = deviceConfig();
  await refresh();
  records += 100;
  await refresh();
  const host = document.createElement('div');
  render(
    <>
      <AudioDelivery onSetupBridge={() => {}} />
      <BridgeWizard onClose={() => {}} />
    </>,
    host,
  );
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Continue')
      ?.click(),
  );
  expect(host.textContent).toContain('Input is quiet');
  expect(host.textContent).toContain('Target saved. Play a track to check transmission.');
  expect(host.textContent).not.toContain('The device is sending audio');

  playing = true;
  bytes = 1024;
  await act(async () => {
    await refresh();
  });
  expect(host.textContent).toContain('Sending audio');
  expect(host.textContent).toContain('The device is sending audio');

  playing = false;
  records += 100;
  bytes += 1024;
  await act(async () => {
    await refresh();
  });
  expect(host.textContent).toContain('Input is quiet');
  expect(host.textContent).not.toContain('The device is sending audio');
  render(null, host);
});
it('never presents historical packet movement as a live transmission', () => {
  status.value = deviceStatus();
  audioMoving.value = true;
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
