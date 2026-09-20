import { beforeEach, describe, expect, it } from 'vitest';
import { deviceStatus } from '../src/mocks/fixtures';
import { bridgeConnection, packetsMoving, status } from '../src/state/device';

describe('bridgeConnection', () => {
  beforeEach(() => {
    status.value = null;
    packetsMoving.value = false;
  });

  it('reads unset before the first status', () => {
    expect(bridgeConnection.value).toBe('unset');
  });

  it('reads setup while the device runs its own network', () => {
    status.value = deviceStatus({ mode: 'setup' });
    expect(bridgeConnection.value).toBe('setup');
  });

  it('reads unset when provisioned without a target', () => {
    status.value = deviceStatus({ target: { target_host: '' } });
    expect(bridgeConnection.value).toBe('unset');
  });

  it('reads idle when streaming is paused even if the input plays', () => {
    status.value = deviceStatus({ stream: { enabled: false }, metrics: { playing: true } });
    expect(bridgeConnection.value).toBe('idle');
  });

  it('reads connecting while enabled before any packet moves, including silence', () => {
    status.value = deviceStatus({ metrics: { playing: false } });
    expect(bridgeConnection.value).toBe('connecting');
  });

  it('reads sending once packets move between polls even during silence', () => {
    status.value = deviceStatus({ metrics: { playing: false } });
    packetsMoving.value = true;
    expect(bridgeConnection.value).toBe('sending');
  });
});
