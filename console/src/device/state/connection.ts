/**
 * Whether the console is in contact with the device, and what an absence
 * means: lost contact, a restart the console asked for, or a handoff to
 * another network. One reducer over poll outcomes, so every surface tells the
 * same story and a timer never stands in for evidence.
 */

import type { SetupNetworkResponse, StatusResponse } from '../../generated/api';

/** A restart still unanswered after this reads as overdue on every surface. */
export const OVERDUE_MS = 60_000;

/** What a restart into new firmware is called on every surface. */
export const UPDATE_OPERATION = 'the firmware update';

/**
 * How long the old boot may go on answering after a Wi-Fi save whose answer
 * was lost. Saving Wi-Fi always restarts the device, so past this the save
 * never reached it.
 */
export const JOIN_GRACE_MS = 15_000;

/** Update phases in which the device is writing or about to boot a new image. */
const INSTALLING: readonly string[] = ['downloading', 'verifying', 'installed'];

/**
 * Uptime counts whole seconds and a read takes time to answer, so a restart
 * shows only once the reported uptime falls this far below the expected one.
 */
const UPTIME_SLACK_S = 2;

/** The device's last answer and when it arrived. */
export interface Sighting {
  status: StatusResponse;
  at: number;
}

/** The device left this browser's network on purpose, so nothing here can answer. */
export type Handoff =
  /** Wi-Fi saved; unconfirmed when the connection dropped before the device answered. */
  | { kind: 'join'; ssid: string; confirmed: boolean }
  /** Factory reset; the setup network the response named, or null when it was lost. */
  | { kind: 'reset'; setupNetwork: SetupNetworkResponse | null };

export type Connection =
  /** Before the first answer. */
  | { phase: 'opening' }
  | { phase: 'live'; seen: Sighting }
  /** A read failed or went unanswered without a restart to explain it. */
  | { phase: 'lost'; since: number; seen: Sighting | null }
  /** A restart was asked for and has not been seen to finish. */
  | { phase: 'waiting'; operation: string; since: number; seen: Sighting | null }
  | { phase: 'overdue'; operation: string; since: number; seen: Sighting | null }
  | { phase: 'handoff'; handoff: Handoff; since: number; seen: Sighting | null };

export type ConnectionEvent =
  | { type: 'answered'; status: StatusResponse; at: number }
  | { type: 'unanswered'; at: number }
  /** A write answered `rebooting: true`; `operation` names what the restart applies. */
  | { type: 'restarting'; operation: string; at: number }
  | { type: 'handoff'; handoff: Handoff; at: number };

/** The device's last answer, whatever the phase. */
export function sightingOf(connection: Connection): Sighting | null {
  return connection.phase === 'opening' ? null : connection.seen;
}

/**
 * Whether `status` comes from a boot that started after `seen`: its uptime is
 * well below what the earlier answer plus the time since would make it.
 */
export function restartedSince(seen: Sighting | null, status: StatusResponse, at: number): boolean {
  if (!seen) return true;
  const expected = seen.status.system.uptime_seconds + (at - seen.at) / 1000;
  return status.system.uptime_seconds + UPTIME_SLACK_S < expected;
}

export function nextConnection(connection: Connection, event: ConnectionEvent): Connection {
  const seen = sightingOf(connection);
  switch (event.type) {
    case 'restarting':
      if (connection.phase === 'handoff') return connection;
      return { phase: 'waiting', operation: event.operation, since: event.at, seen };
    case 'handoff':
      return { phase: 'handoff', handoff: event.handoff, since: event.at, seen };
    case 'answered': {
      const sighting = { status: event.status, at: event.at };
      // The old boot can still answer before it goes down.
      const awaitsRestart =
        connection.phase === 'waiting' ||
        connection.phase === 'overdue' ||
        connection.phase === 'handoff';
      if (
        !awaitsRestart ||
        restartedSince(seen, event.status, event.at) ||
        joinNotTaken(connection, event.at)
      ) {
        // A device that installed an update restarts into it next.
        if (event.status.ota.phase === 'installed' && !awaitsRestart) {
          return { phase: 'waiting', operation: UPDATE_OPERATION, since: event.at, seen: sighting };
        }
        return { phase: 'live', seen: sighting };
      }
      // An install still under way: the silence was not its restart.
      if (
        connection.phase !== 'handoff' &&
        connection.operation === UPDATE_OPERATION &&
        INSTALLING.includes(event.status.ota.phase) &&
        event.status.ota.phase !== 'installed'
      ) {
        return { phase: 'live', seen: sighting };
      }
      return overdueBy({ ...connection, seen: sighting }, event.at);
    }
    case 'unanswered':
      // A device that stops answering mid-install may be restarting into it.
      if (connection.phase === 'live' && INSTALLING.includes(connection.seen.status.ota.phase)) {
        return { phase: 'waiting', operation: UPDATE_OPERATION, since: event.at, seen };
      }
      if (connection.phase === 'opening' || connection.phase === 'live') {
        return { phase: 'lost', since: event.at, seen };
      }
      return overdueBy(connection, event.at);
  }
}

/** An unconfirmed join the same boot still answers well after: the save never reached it. */
function joinNotTaken(connection: Connection, at: number): boolean {
  return (
    connection.phase === 'handoff' &&
    connection.handoff.kind === 'join' &&
    !connection.handoff.confirmed &&
    at - connection.since >= JOIN_GRACE_MS
  );
}

/** The network a transition shows the device never joined, or null. */
export function untakenJoin(previous: Connection, next: Connection): string | null {
  if (previous.phase !== 'handoff' || previous.handoff.kind !== 'join' || next.phase !== 'live') {
    return null;
  }
  return joinNotTaken(previous, next.seen.at) &&
    !restartedSince(previous.seen, next.seen.status, next.seen.at)
    ? previous.handoff.ssid
    : null;
}

function overdueBy(connection: Connection, at: number): Connection {
  if (connection.phase === 'waiting' && at - connection.since >= OVERDUE_MS) {
    return { ...connection, phase: 'overdue' };
  }
  return connection;
}

/** The restart a transition saw finish, or null: a wait that ends without a new boot settles none. */
export function settledRestart(previous: Connection, next: Connection): string | null {
  const waited = previous.phase === 'waiting' || previous.phase === 'overdue';
  if (!waited || next.phase !== 'live') return null;
  return restartedSince(previous.seen, next.seen.status, next.seen.at) ? previous.operation : null;
}
