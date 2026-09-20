import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { config, packetsMoving, status } from '../src/state/device';

describe('network connection state', () => {
  it('preserves an edited target when unrelated settings refresh', async () => {
    config.value = deviceConfig();
    status.value = deviceStatus();
    const host = document.createElement('div');
    await act(async () => render(<NetworkTab onSetupBridge={() => {}} />, host));
    const input = host.querySelector<HTMLInputElement>('#target_host');
    if (!input) throw new Error('target host field missing');
    await act(async () => {
      input.value = 'bridge.example';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      config.value = { ...deviceConfig(), device_name: 'Listening room' };
    });
    expect(input.value).toBe('bridge.example');
    render(null, host);
  });
  it.each([
    { playing: false, enabled: true, moving: false, label: 'idle — nothing to send' },
    { playing: true, enabled: true, moving: false, label: 'connecting to bridge…' },
    { playing: true, enabled: false, moving: false, label: 'streaming paused' },
    { playing: false, enabled: true, moving: true, label: 'sending audio' },
  ])('reports $label from stream activity', ({ playing, enabled, moving, label }) => {
    config.value = deviceConfig();
    status.value = deviceStatus({ metrics: { playing }, stream: { enabled } });
    packetsMoving.value = moving;
    const host = document.createElement('div');
    render(<NetworkTab onSetupBridge={() => {}} />, host);
    expect(host.querySelector('.healthchip')?.textContent).toBe(label);
    render(null, host);
  });
});
