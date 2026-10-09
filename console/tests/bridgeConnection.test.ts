import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../src/lib/api';
import { deviceStatus } from '../src/mocks/fixtures';
import { audioMoving, bridgeConnection, refresh, status, unreachable } from '../src/state/device';

describe('bridgeConnection', () => {
  beforeEach(() => {
    status.value = null;
    audioMoving.value = false;
    unreachable.value = false;
  });
  afterEach(() => setTransport((request) => fetch(request)));

  it('reports an unavailable device even when the first poll fails', async () => {
    setTransport(async () => {
      throw new TypeError('offline');
    });
    await refresh();
    expect(unreachable.value).toBe(true);
    expect(bridgeConnection.value).toBe('unavailable');
  });

  it('clears live transmission evidence on failure and establishes a new baseline after recovery', async () => {
    let bytes = 10240;
    setTransport(
      async () => new Response(JSON.stringify(deviceStatus({ metrics: { bytes_total: bytes++ } }))),
    );
    await refresh();
    await refresh();
    expect(audioMoving.value).toBe(true);
    setTransport(async () => {
      throw new TypeError('offline');
    });
    await refresh();
    expect(audioMoving.value).toBe(false);
    expect(bridgeConnection.value).toBe('unavailable');
    setTransport(
      async () => new Response(JSON.stringify(deviceStatus({ metrics: { bytes_total: 99999 } }))),
    );
    await refresh();
    expect(unreachable.value).toBe(false);
    expect(audioMoving.value).toBe(false);
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

  it('reads idle when a target is set but the input is quiet', () => {
    status.value = deviceStatus({ metrics: { playing: false } });
    expect(bridgeConnection.value).toBe('idle');
  });

  it('reads connecting when audio plays before any packet moves', () => {
    status.value = deviceStatus({ metrics: { playing: true } });
    expect(bridgeConnection.value).toBe('connecting');
  });

  it('reads idle while transmission is paused even when audio plays', () => {
    status.value = deviceStatus({ metrics: { playing: true }, stream: { enabled: false } });
    audioMoving.value = true;
    expect(bridgeConnection.value).toBe('idle');
  });

  it('reads sending once PCM bytes move between polls', () => {
    status.value = deviceStatus({ metrics: { playing: true } });
    audioMoving.value = true;
    expect(bridgeConnection.value).toBe('sending');
  });
});
