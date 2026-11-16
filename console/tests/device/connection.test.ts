import { describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  type Connection,
  type ConnectionEvent,
  JOIN_GRACE_MS,
  nextConnection,
  OVERDUE_MS,
  restartedSince,
  settledRestart,
  UPDATE_OPERATION,
  untakenJoin,
} from '../../src/device/state/connection';
import type { StatusResponse } from '../../src/generated/api';

/** A device that has been up for `uptime` seconds. */
function up(uptime: number, overrides: Parameters<typeof deviceStatus>[0] = {}): StatusResponse {
  const status = deviceStatus(overrides);
  return { ...status, system: { ...status.system, uptime_seconds: uptime } };
}

function run(events: ConnectionEvent[], from: Connection = { phase: 'opening' }): Connection {
  return events.reduce(nextConnection, from);
}

const answered = (status: StatusResponse, at: number): ConnectionEvent => ({
  type: 'answered',
  status,
  at,
});
const unanswered = (at: number): ConnectionEvent => ({ type: 'unanswered', at });
const restarting = (at: number): ConnectionEvent => ({
  type: 'restarting',
  operation: 'the board',
  at,
});

describe('contact', () => {
  it('is live from the first answer and lost from the first unanswered read', () => {
    const live = run([answered(up(100), 0)]);
    expect(live.phase).toBe('live');
    const lost = run([unanswered(1500)], live);
    expect(lost).toMatchObject({ phase: 'lost', since: 1500 });
    // The last answer survives for facts a restart does not change.
    expect(lost.phase === 'lost' && lost.seen?.status.system.uptime_seconds).toBe(100);
    expect(run([unanswered(3000)], lost)).toMatchObject({ phase: 'lost', since: 1500 });
    expect(run([answered(up(103), 4500)], lost).phase).toBe('live');
  });

  it('is lost when the page never heard from the device', () => {
    expect(run([unanswered(0)])).toMatchObject({ phase: 'lost', seen: null });
  });
});

describe('a restart', () => {
  it('waits through answers from the boot that is going down', () => {
    const waiting = run([answered(up(100), 0), restarting(1000), answered(up(101), 1500)]);
    expect(waiting).toMatchObject({ phase: 'waiting', operation: 'the board', since: 1000 });
  });

  it('finishes on the first answer from a new boot, failed reads or not', () => {
    const before = run([answered(up(100), 0), restarting(1000)]);
    const quick = run([answered(up(1), 2500)], before);
    expect(quick.phase).toBe('live');
    expect(settledRestart(before, quick)).toBe('the board');

    const slow = run([unanswered(2500), unanswered(4000), answered(up(4), 9000)], before);
    expect(slow.phase).toBe('live');
  });

  it('reads as overdue after a minute, and a late return still finishes it', () => {
    const before = run([answered(up(100), 0), restarting(1000)]);
    const almost = run([unanswered(1000 + OVERDUE_MS - 1)], before);
    expect(almost.phase).toBe('waiting');
    const overdue = run([unanswered(1000 + OVERDUE_MS)], before);
    expect(overdue).toMatchObject({ phase: 'overdue', operation: 'the board' });
    const late = run([answered(up(5), 1000 + OVERDUE_MS + 5000)], overdue);
    expect(late.phase).toBe('live');
    expect(settledRestart(overdue, late)).toBe('the board');
  });

  it('turns overdue while the old boot keeps answering past a minute', () => {
    const before = run([answered(up(100), 0), restarting(1000)]);
    expect(run([answered(up(161), 1000 + OVERDUE_MS)], before).phase).toBe('overdue');
  });

  it('settles nothing when live contact simply continues', () => {
    const live = run([answered(up(100), 0)]);
    expect(settledRestart(live, run([answered(up(101), 1500)], live))).toBeNull();
  });
});

describe('an update', () => {
  const installing = (uptime: number, phase: string) => up(uptime, { ota: { phase } });

  it('waits for its restart once the device says it installed', () => {
    const waiting = run([
      answered(installing(100, 'downloading'), 0),
      answered(installing(101, 'installed'), 1500),
    ]);
    expect(waiting).toMatchObject({ phase: 'waiting', operation: UPDATE_OPERATION, since: 1500 });
    const booted = run([unanswered(3000), answered(installing(3, 'idle'), 9000)], waiting);
    expect(booted.phase).toBe('live');
    expect(settledRestart(waiting, booted)).toBe(UPDATE_OPERATION);
  });

  it('reads a failed read mid-install as its restart, not as lost contact', () => {
    const waiting = run([answered(installing(100, 'downloading'), 0), unanswered(1500)]);
    expect(waiting).toMatchObject({ phase: 'waiting', operation: UPDATE_OPERATION });
  });

  it('goes back to live when the same boot answers, still downloading, settling nothing', () => {
    const waiting = run([answered(installing(100, 'downloading'), 0), unanswered(1500)]);
    const resumed = run([answered(installing(103, 'downloading'), 3000)], waiting);
    expect(resumed.phase).toBe('live');
    expect(settledRestart(waiting, resumed)).toBeNull();
  });
});

describe('a handoff', () => {
  const join: ConnectionEvent = {
    type: 'handoff',
    handoff: { kind: 'join', ssid: 'home', confirmed: true },
    at: 1000,
  };

  it('outlasts answers from the boot that saved the change, failed reads and restarts', () => {
    const handoff = run([answered(up(100, { mode: 'setup' }), 0), join]);
    expect(run([answered(up(101, { mode: 'setup' }), 1500)], handoff).phase).toBe('handoff');
    expect(run([unanswered(OVERDUE_MS * 2)], handoff).phase).toBe('handoff');
    expect(run([restarting(2000)], handoff).phase).toBe('handoff');
  });

  it('ends when a new boot answers here, such as a failed join back on the setup network', () => {
    const handoff = run([answered(up(100, { mode: 'setup' }), 0), join]);
    const back = run([unanswered(1500), answered(up(6, { mode: 'recovery' }), 30_000)], handoff);
    expect(back.phase).toBe('live');
    expect(back.phase === 'live' && back.seen.status.mode).toBe('recovery');
    expect(settledRestart(handoff, back)).toBeNull();
  });
});

describe('restartedSince', () => {
  it('takes any answer as new when there was none before', () => {
    expect(restartedSince(null, up(500), 0)).toBe(true);
  });

  it('allows for whole-second uptime and read latency', () => {
    const seen = { status: up(100), at: 0 };
    expect(restartedSince(seen, up(100), 1000)).toBe(false);
    expect(restartedSince(seen, up(99), 1000)).toBe(false);
    expect(restartedSince(seen, up(98), 1000)).toBe(true);
  });
});

describe('a Wi-Fi change whose answer was lost', () => {
  const join = (at: number): ConnectionEvent => ({
    type: 'handoff',
    handoff: { kind: 'join', ssid: 'home', confirmed: false },
    at,
  });

  it('waits out the old boot, then returns when it still answers: the save never reached it', () => {
    const before = run([answered(up(100), 0), join(1_000)]);
    const soon = run([answered(up(105), 5_000)], before);
    expect(soon.phase).toBe('handoff');
    const after = run(
      [answered(up(100 + 1 + JOIN_GRACE_MS / 1000), 1_000 + JOIN_GRACE_MS)],
      before,
    );
    expect(after.phase).toBe('live');
    expect(untakenJoin(before, after)).toBe('home');
  });

  it('ends at the new boot as before, which did join', () => {
    const before = run([answered(up(100), 0), join(1_000)]);
    const after = run([answered(up(3), 30_000)], before);
    expect(after.phase).toBe('live');
    expect(untakenJoin(before, after)).toBeNull();
  });
});
