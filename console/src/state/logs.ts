/**
 * Device log state: what `GET /api/logs` returns, accumulated across reads.
 *
 * The device holds a few kilobytes of lines and discards the oldest to make
 * room, so a reader that only ever shows the latest response loses everything
 * that scrolled past between two reads. Merging by sequence number keeps a
 * longer window here than the device can hold, and counts what went missing
 * either way rather than presenting a log with silent holes.
 */

import { signal } from '@preact/signals';
import { type BootLog, getLogs } from '../lib/api';
import { errorMessage } from '../lib/errors';

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

/** The running boot, merged across reads. */
export const currentLog = signal<BootLogView>(EMPTY_BOOT_LOG);
/**
 * The boot before this one, as the device reported it. Never merged: it is
 * already final, and the device returns the same lines every time.
 */
export const previousLog = signal<BootLogView | null>(null);
export const logsError = signal('');
export const logsLoading = signal(false);

let inflight = false;

/** Read the device log once. Overlapping calls collapse into the running one. */
export async function loadLogs(): Promise<void> {
  if (inflight) return;
  inflight = true;
  logsLoading.value = true;
  try {
    const response = await getLogs();
    currentLog.value = mergeBootLog(currentLog.value, response.current);
    previousLog.value = response.previous
      ? {
          boot: response.previous.boot,
          lines: numberedLines(response.previous),
          droppedByDevice: response.previous.dropped,
          trimmed: 0,
        }
      : null;
    logsError.value = '';
  } catch (cause) {
    logsError.value = errorMessage(cause);
  } finally {
    inflight = false;
    logsLoading.value = false;
  }
}

/** Drop everything held, so a fresh read starts from what the device has. */
export function clearLogs(): void {
  currentLog.value = EMPTY_BOOT_LOG;
  previousLog.value = null;
  logsError.value = '';
}

/** One boot's lines as text, for the clipboard. */
export function logText(view: BootLogView): string {
  const header = hiddenLines(view)
    ? [`… ${hiddenLines(view)} earlier lines are no longer held`]
    : [];
  return [...header, ...view.lines.map((line) => line.text)].join('\n');
}
