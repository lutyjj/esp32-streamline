import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/device/lib/api';
import { FakeDevice } from '../../src/device/mocks/device';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  adoptFound,
  bridgeConsoleAddress,
  consoleAddressAfterUse,
  DISCOVERY_DEADLINE_MS,
  discovery,
  fillsTarget,
  findBridges,
  searchOffered,
} from '../../src/device/state/discovery';
import { answering } from './answering';

const BRIDGE = { name: 'StreamLine Bridge', host: '192.0.2.20', port: 39000, http_port: 8088 };

function serve(device: FakeDevice): { browses: () => number } {
  let browses = 0;
  setTransport(async (request) => {
    if (new URL(request.url).pathname === '/api/bridges') browses += 1;
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  return { browses: () => browses };
}

describe('bridge discovery', () => {
  beforeEach(() => {
    discovery.value = { phase: 'idle' };
  });

  afterEach(() => {
    vi.useRealTimers();
    setTransport((request) => fetch(request));
  });

  it('lists what the device found on its network', async () => {
    const device = new FakeDevice();
    device.bridges = [BRIDGE];
    serve(device);

    await findBridges();

    expect(discovery.value).toEqual({ phase: 'found', bridges: [BRIDGE] });
  });

  it('names why a device on its setup network cannot search', async () => {
    serve(new FakeDevice('recovery'));

    await findBridges();

    expect(discovery.value).toEqual({
      phase: 'failed',
      reason: 'bridge discovery needs the home network',
    });
  });

  it('joins a search already running instead of browsing twice', async () => {
    const counter = serve(new FakeDevice());

    const first = findBridges();
    await findBridges();

    expect(discovery.value.phase).toBe('found');
    await first;
    expect(counter.browses()).toBe(1);
  });

  it('gives up on a device that never answers and names the fallback reason', async () => {
    vi.useFakeTimers();
    setTransport(
      (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason)),
        ),
    );

    const search = findBridges();
    expect(discovery.value.phase).toBe('searching');
    await vi.advanceTimersByTimeAsync(DISCOVERY_DEADLINE_MS);
    await search;

    expect(discovery.value).toEqual({
      phase: 'failed',
      reason: 'the device did not answer within 10 seconds',
    });
  });

  it('matches a bridge to the target fields, ignoring surrounding spaces', () => {
    expect(fillsTarget(BRIDGE, ' 192.0.2.20 ', '39000')).toBe(true);
    expect(fillsTarget(BRIDGE, '192.0.2.20', '39001')).toBe(false);
    expect(fillsTarget(BRIDGE, 'bridge.local', '39000')).toBe(false);
  });

  it('replaces a console address Use filled, never one the owner typed', () => {
    const other = { ...BRIDGE, host: '192.0.2.21' };

    expect(consoleAddressAfterUse('', '', BRIDGE)).toBe('http://192.0.2.20:8088/');
    expect(
      consoleAddressAfterUse('http://192.0.2.20:8088/', 'http://192.0.2.20:8088/', other),
    ).toBe('http://192.0.2.21:8088/');
    expect(consoleAddressAfterUse('https://ha.example/bridge', '', other)).toBeNull();
    expect(consoleAddressAfterUse('http://192.0.2.20:8088/', '', other)).toBeNull();
  });

  it('builds the console address only from an advertised HTTP port', () => {
    expect(bridgeConsoleAddress(BRIDGE)).toBe('http://192.0.2.20:8088/');
    expect(bridgeConsoleAddress({ ...BRIDGE, http_port: null })).toBe('');
  });

  it('fills the form from a found bridge and keeps a console address the owner typed', () => {
    const typed = {
      entry: { host: '', port: '39000' },
      console: 'https://ha.example/bridge',
      consoleFilled: '',
    };
    expect(adoptFound(typed, BRIDGE)).toEqual({
      entry: { host: '192.0.2.20', port: '39000' },
      console: 'https://ha.example/bridge',
      consoleFilled: '',
    });
    const empty = { entry: { host: '', port: '' }, console: '', consoleFilled: '' };
    const used = adoptFound(empty, BRIDGE);
    expect(used.console).toBe('http://192.0.2.20:8088/');
    expect(adoptFound(used, { ...BRIDGE, host: '192.0.2.21' }).console).toBe(
      'http://192.0.2.21:8088/',
    );
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
