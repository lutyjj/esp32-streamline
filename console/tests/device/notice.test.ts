import { describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import type { Connection } from '../../src/device/state/connection';
import { deviceNotice, OVERDUE_TEXT } from '../../src/device/state/notice';

const home = { status: deviceStatus(), at: 0 };
const recovering = {
  status: deviceStatus({
    mode: 'recovery',
    wifi: { ssid: 'Study Wi-Fi', status: 'ap', join_failure: 'network-not-found' },
  }),
  at: 0,
};

describe('deviceNotice', () => {
  it('says nothing while contact is live on the home network, opening, or handed off', () => {
    expect(deviceNotice({ phase: 'live', seen: home })).toBeNull();
    expect(deviceNotice({ phase: 'opening' })).toBeNull();
    const handoff: Connection = {
      phase: 'handoff',
      handoff: { kind: 'join', ssid: 'home', confirmed: true },
      since: 0,
      seen: home,
    };
    expect(deviceNotice(handoff)).toBeNull();
  });

  it('names the operation a restart applies', () => {
    const notice = deviceNotice({
      phase: 'waiting',
      operation: 'the board',
      since: 0,
      seen: home,
    });
    expect(notice).toMatchObject({ tone: 'progress' });
    expect(notice?.text).toContain('Restarting to apply the board');
  });

  it('marks lost contact as a failure and an overdue restart as a fallback warning', () => {
    expect(deviceNotice({ phase: 'lost', since: 0, seen: home })?.tone).toBe('failure');
    expect(deviceNotice({ phase: 'lost', since: 0, seen: null })?.tone).toBe('failure');
    const overdue = deviceNotice({
      phase: 'overdue',
      operation: 'the restart',
      since: 0,
      seen: home,
    });
    expect(overdue).toEqual({ tone: 'attention', text: OVERDUE_TEXT });
  });

  it('names the cause and offers Change Wi-Fi in recovery', () => {
    const notice = deviceNotice({ phase: 'live', seen: recovering });
    expect(notice).toMatchObject({ tone: 'attention', action: 'change-wifi' });
    expect(notice?.text).toContain('can’t find Study Wi-Fi');
  });

  it('sends a browser that lost the setup network to the home address, restart or not', () => {
    for (const connection of [
      { phase: 'lost', since: 0, seen: recovering },
      { phase: 'overdue', operation: 'the restart', since: 0, seen: recovering },
    ] as const) {
      const notice = deviceNotice(connection);
      expect(notice?.text).toContain('http://streamline-0000.local/');
      expect(notice?.action).toBeUndefined();
    }
  });
});
