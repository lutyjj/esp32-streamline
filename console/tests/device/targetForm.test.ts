import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  rememberBridgeConsole,
  rememberedBridgeConsole,
} from '../../src/device/state/bridgeConsole';
import { connection } from '../../src/device/state/device';
import {
  adoptFound,
  consoleAddressAfterUse,
  draftChanges,
  fillsTarget,
  savedDraft,
  saveTarget,
} from '../../src/device/state/targetForm';
import { answering } from './answering';

const BRIDGE = { name: 'StreamLine Bridge', host: '192.0.2.20', port: 39000, http_port: 8088 };

describe('the bridge target form', () => {
  afterEach(() => {
    localStorage.clear();
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

  it('opens the form on the saved target and the console address kept for it', () => {
    rememberBridgeConsole('192.0.2.20:39001', 'http://192.0.2.20:8088/');
    expect(savedDraft({ target_host: '192.0.2.20', target_port: 39001 })).toEqual({
      entry: { host: '192.0.2.20', port: '39001' },
      console: 'http://192.0.2.20:8088/',
      consoleFilled: '',
    });
    // No target yet: the bridge's usual port, and no console address.
    expect(savedDraft({ target_host: '', target_port: 0 }).entry).toEqual({
      host: '',
      port: '39000',
    });
  });

  it('counts a change only where a save would write something else', () => {
    const saved = savedDraft({ target_host: '192.0.2.20', target_port: 39000 });
    const spaced = { ...saved, entry: { host: ' 192.0.2.20 ', port: '39000' } };
    expect(draftChanges(spaced, saved)).toEqual({ target: false, console: false });
    expect(draftChanges(adoptFound(saved, { ...BRIDGE, host: '192.0.2.21' }), saved)).toEqual({
      target: true,
      console: true,
    });
    expect(draftChanges({ ...saved, console: 'http://192.0.2.20:8088/' }, saved)).toEqual({
      target: false,
      console: true,
    });
  });
});

describe('saving the bridge target', () => {
  let writes: string[] = [];

  beforeEach(() => {
    writes = [];
    answering(deviceStatus());
    unlockSettings('a'.repeat(48), false);
    setTransport(async (request) => {
      writes.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return Response.json({ ok: true, rebooting: true });
    });
  });

  afterEach(() => {
    forgetAdminKey();
    localStorage.clear();
    setTransport((request) => fetch(request));
  });

  it('writes a new target, follows the restart, and keeps the console address', async () => {
    const saved = savedDraft({ target_host: '192.0.2.20', target_port: 39000 });
    const draft = adoptFound(saved, { ...BRIDGE, host: '192.0.2.21' });

    await expect(saveTarget(draft, saved)).resolves.toBe(true);

    expect(writes).toEqual(['POST /api/settings/target target_host=192.0.2.21&target_port=39000']);
    expect(connection.value).toMatchObject({ phase: 'waiting', operation: 'the bridge change' });
    expect(rememberedBridgeConsole('192.0.2.21:39000')).toBe('http://192.0.2.21:8088/');
  });

  it('keeps a console address alone in this browser, without a write or a restart', async () => {
    const saved = savedDraft({ target_host: '192.0.2.20', target_port: 39000 });
    const draft = { ...saved, console: ' https://ha.example/bridge ' };

    await expect(saveTarget(draft, saved)).resolves.toBe(true);

    expect(writes).toEqual([]);
    expect(connection.value.phase).toBe('live');
    expect(rememberedBridgeConsole('192.0.2.20:39000')).toBe('https://ha.example/bridge');
  });
});
