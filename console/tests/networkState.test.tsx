import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { NetworkTab } from '../src/components/NetworkTab';
import { deviceConfig, deviceStatus } from '../src/mocks/fixtures';
import { config, packetsMoving, status } from '../src/state/device';

describe('network connection state', () => {
  it.each([
    { playing: false, enabled: true, moving: false, label: 'connecting to bridge…' },
    { playing: true, enabled: false, moving: false, label: 'streaming paused' },
    { playing: false, enabled: true, moving: true, label: 'connection healthy' },
  ])('reports $label independently of input activity', ({ playing, enabled, moving, label }) => {
    config.value = deviceConfig();
    status.value = deviceStatus({ metrics: { playing }, stream: { enabled } });
    packetsMoving.value = moving;
    const host = document.createElement('div');
    render(<NetworkTab onSetupBridge={() => {}} />, host);
    expect(host.querySelector('.healthchip')?.textContent).toBe(label);
    render(null, host);
  });
});
