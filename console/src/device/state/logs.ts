/**
 * Device log state: what `GET /api/logs` returns, accumulated across reads.
 *
 * The device holds a few kilobytes of lines and discards the oldest to make
 * room, so a reader that only ever shows the latest response loses everything
 * that scrolled past between two reads. Merging by sequence number keeps a
 * longer window here than the device can hold, and counts what went missing
 * either way rather than presenting a log with silent holes.
 */

import { queryOptions } from '@tanstack/preact-query';
import { type BootLog, getLogs } from '../../generated/api';
import { queryClient } from '../../shared/queries';

/** One line, numbered within its boot. */
export interface LogLine {
  sequence: number;
  text: string;
}

/** Lines kept per boot. Beyond this the oldest are trimmed and counted. */
export const RETAINED_LINES = 1_000;

/** How often following re-reads. Slower than the status poll: the response
 *  carries the whole buffer, and nobody reads faster than this. */
export const FOLLOW_MS = 3_000;

export interface BootLogView {
  /** Which run of the firmware these lines came from. */
  boot: number;
  lines: LogLine[];
  /** Lines the device's buffer discarded before this console read them. */
  droppedByDevice: number;
  /** Lines this console discarded to stay within [`RETAINED_LINES`]. */
  trimmed: number;
}

export const EMPTY_BOOT_LOG: BootLogView = { boot: 0, lines: [], droppedByDevice: 0, trimmed: 0 };

/** Lines that existed and can no longer be shown, whoever discarded them. */
export function hiddenLines(view: BootLogView): number {
  return view.droppedByDevice + view.trimmed;
}

/**
 * Split one boot's block into numbered lines. The device sends the log as
 * text, which is what it holds; `first_sequence` names the first line and each
 * one after it counts up, so every line keeps an identity across reads.
 */
export function numberedLines(boot: BootLog): LogLine[] {
  return boot.text
    .split('\n')
    .filter((text) => text.length > 0)
    .map((text, offset) => ({ sequence: boot.first_sequence + offset, text }));
}

/**
 * Fold one response into what is already held.
 *
 * Sequence numbers only mean something within one boot, and a restart starts
 * them again from zero. Comparing them across boots cannot detect that: two
 * reads that straddle a restart may not overlap at all, and the second one's
 * numbers can be higher than the first's. The device's boot id is what
 * distinguishes the two, so a change in it replaces the held view instead of
 * appending a different device run to it.
 */
export function mergeBootLog(held: BootLogView, incoming: BootLog): BootLogView {
  const base = incoming.boot === held.boot ? held : EMPTY_BOOT_LOG;

  const since = base.lines.at(-1)?.sequence ?? -1;
  const lines = [...base.lines, ...numberedLines(incoming).filter((line) => line.sequence > since)];
  const excess = Math.max(0, lines.length - RETAINED_LINES);

  return {
    boot: incoming.boot,
    lines: excess ? lines.slice(excess) : lines,
    droppedByDevice: incoming.dropped,
    trimmed: base.trimmed + excess,
  };
}

/** What the console holds of the device log. */
export interface DeviceLog {
  /** The running boot, merged across reads. */
  current: BootLogView;
  /**
   * The boot before this one, as the device reported it. Never merged: it is
   * already final, and the device returns the same lines every time.
   */
  previous: BootLogView | null;
}

const LOGS_KEY = ['logs'] as const;

/**
 * The device log as a read: each one merges into what the cache holds, so a
 * screen that follows it (`refetchInterval: FOLLOW_MS`) keeps more than the
 * device can, and a failed read leaves what was shown.
 */
export const logsQuery = queryOptions({
  queryKey: LOGS_KEY,
  queryFn: async (): Promise<DeviceLog> => {
    const response = await getLogs();
    const held = queryClient.getQueryData<DeviceLog>(LOGS_KEY);
    return {
      current: mergeBootLog(held?.current ?? EMPTY_BOOT_LOG, response.current),
      previous: response.previous
        ? {
            boot: response.previous.boot,
            lines: numberedLines(response.previous),
            droppedByDevice: response.previous.dropped,
            trimmed: 0,
          }
        : null,
    };
  },
});

/** Drop everything held, so a fresh read starts from what the device has. */
export function clearLogs(): void {
  queryClient.removeQueries({ queryKey: LOGS_KEY });
}

/** One boot's lines as text, for the clipboard. */
export function logText(view: BootLogView): string {
  const header = hiddenLines(view)
    ? [`… ${hiddenLines(view)} earlier lines are no longer held`]
    : [];
  return [...header, ...view.lines.map((line) => line.text)].join('\n');
}
