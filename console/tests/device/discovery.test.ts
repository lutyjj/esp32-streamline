import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice } from '../../src/device/mocks/device';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { bridgeConsoleAddress, findBridges, searchOffered } from '../../src/device/state/discovery';
import { answering } from './answering';

const BRIDGE = { name: 'StreamLine Bridge', host: '192.0.2.20', port: 39000, http_port: 8088 };

function serve(device: FakeDevice): void {
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
}

describe('bridge discovery', () => {
  afterEach(() => {
    setTransport((request) => fetch(request));
  });

  it('lists what the device found on its network', async () => {
    const device = new FakeDevice();
    device.bridges = [BRIDGE];
    serve(device);

    await expect(findBridges()).resolves.toEqual([BRIDGE]);
  });

  it('names why a device on its setup network cannot search', async () => {
    serve(new FakeDevice('recovery'));

    await expect(findBridges()).rejects.toThrow('bridge discovery needs the home network');
  });

  it('builds the console address only from an advertised HTTP port', () => {
    expect(bridgeConsoleAddress(BRIDGE)).toBe('http://192.0.2.20:8088/');
    expect(bridgeConsoleAddress({ ...BRIDGE, http_port: null })).toBe('');
  });

  it('offers the search only on the home network', () => {
    answering(deviceStatus());
    expect(searchOffered.value).toBe(true);
    for (const mode of ['setup', 'recovery'] as const) {
      answering(deviceStatus({ mode }));
      expect(searchOffered.value).toBe(false);
    }
    answering(null);
  });
});
