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
import { type BootLog, getLogs, type LoggedLine } from '../lib/api';
import { errorMessage } from '../lib/errors';

/** Lines kept per boot. Beyond this the oldest are trimmed and counted. */
export const RETAINED_LINES = 1_000;

/** How often following re-reads. Slower than the status poll: the response
 *  carries the whole buffer, and nobody reads faster than this. */
export const FOLLOW_MS = 3_000;

export interface BootLogView {
  lines: LoggedLine[];
  /** Lines the device's buffer discarded before this console read them. */
  droppedByDevice: number;
  /** Lines this console discarded to stay within [`RETAINED_LINES`]. */
  trimmed: number;
}

export const EMPTY_BOOT_LOG: BootLogView = { lines: [], droppedByDevice: 0, trimmed: 0 };

/** Lines that existed and can no longer be shown, whoever discarded them. */
export function hiddenLines(view: BootLogView): number {
  return view.droppedByDevice + view.trimmed;
}

/**
 * Fold one response into what is already held.
 *
 * A restart resets the device's sequence numbers to zero, which shows up as an
 * incoming log that ends earlier than the one held. That is a different boot,
 * not lines going backwards, so the held view is replaced rather than merged.
 */
export function mergeBootLog(held: BootLogView, incoming: BootLog): BootLogView {
  const lastHeld = held.lines.at(-1)?.sequence ?? -1;
  const lastIncoming = incoming.lines.at(-1)?.sequence ?? -1;
  const restarted = lastIncoming < lastHeld || incoming.dropped < held.droppedByDevice;
  const base = restarted ? EMPTY_BOOT_LOG : held;

  const since = base.lines.at(-1)?.sequence ?? -1;
  const lines = [...base.lines, ...incoming.lines.filter((line) => line.sequence > since)];
  const excess = Math.max(0, lines.length - RETAINED_LINES);

  return {
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
          lines: response.previous.lines,
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
