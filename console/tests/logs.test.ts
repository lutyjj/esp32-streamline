import { beforeEach, describe, expect, it } from 'vitest';
import type { BootLog } from '../src/lib/api';
import { setTransport } from '../src/lib/api';
import {
  clearLogs,
  currentLog,
  EMPTY_BOOT_LOG,
  hiddenLines,
  loadLogs,
  logText,
  mergeBootLog,
  previousLog,
  RETAINED_LINES,
} from '../src/state/logs';

const BOOT = 4242;

function bootLog(from: number, count: number, dropped = 0, boot = BOOT): BootLog {
  return {
    boot,
    lines: Array.from({ length: count }, (_, offset) => ({
      sequence: from + offset,
      text: `line ${from + offset}`,
    })),
    dropped,
  };
}

function texts(view: { lines: { text: string }[] }): string[] {
  return view.lines.map((line) => line.text);
}

describe('merging device log reads', () => {
  it('keeps the first read as it arrived', () => {
    const merged = mergeBootLog(EMPTY_BOOT_LOG, bootLog(0, 3));
    expect(texts(merged)).toEqual(['line 0', 'line 1', 'line 2']);
    expect(hiddenLines(merged)).toBe(0);
  });

  it('appends only lines it has not seen', () => {
    const first = mergeBootLog(EMPTY_BOOT_LOG, bootLog(0, 3));
    const second = mergeBootLog(first, bootLog(1, 4));
    expect(texts(second)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  });

  it('re-reading the same lines changes nothing', () => {
    const first = mergeBootLog(EMPTY_BOOT_LOG, bootLog(0, 3));
    const again = mergeBootLog(first, bootLog(0, 3));
    expect(texts(again)).toEqual(texts(first));
  });

  it('keeps lines the device has already evicted', () => {
    const first = mergeBootLog(EMPTY_BOOT_LOG, bootLog(0, 3));
    // The device dropped lines 0 and 1 between reads; the console still has them.
    const second = mergeBootLog(first, bootLog(2, 3, 2));
    expect(texts(second)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  });

  it('reports lines the device dropped before the console ever saw them', () => {
    const merged = mergeBootLog(EMPTY_BOOT_LOG, bootLog(40, 3, 40));
    expect(hiddenLines(merged)).toBe(40);
  });

  it('starts over when the device restarts', () => {
    const held = mergeBootLog(EMPTY_BOOT_LOG, bootLog(90, 4, 90));
    const afterRestart = mergeBootLog(held, bootLog(0, 2, 0, BOOT + 1));
    expect(texts(afterRestart)).toEqual(['line 0', 'line 1']);
    expect(hiddenLines(afterRestart)).toBe(0);
  });

  it('does not splice a later boot onto an earlier one when reads do not overlap', () => {
    // Read early in one boot, then not again until the next boot had logged
    // past that point: the sequence numbers alone would look like progress.
    const held = mergeBootLog(EMPTY_BOOT_LOG, bootLog(0, 3));
    const afterRestart = mergeBootLog(held, bootLog(20, 2, 20, BOOT + 1));
    expect(texts(afterRestart)).toEqual(['line 20', 'line 21']);
    expect(afterRestart.boot).toBe(BOOT + 1);
  });

  it('trims its own history and counts what it trimmed', () => {
    let view = EMPTY_BOOT_LOG;
    for (let read = 0; read < RETAINED_LINES + 10; read += 1) {
      view = mergeBootLog(view, bootLog(read, 1));
    }
    expect(view.lines).toHaveLength(RETAINED_LINES);
    expect(view.trimmed).toBe(10);
    expect(texts(view).at(-1)).toBe(`line ${RETAINED_LINES + 9}`);
  });

  it('renders copied text with a note about what is missing', () => {
    const view = mergeBootLog(EMPTY_BOOT_LOG, bootLog(5, 2, 5));
    expect(logText(view)).toBe('… 5 earlier lines are no longer held\nline 5\nline 6');
  });
});

describe('reading the device log', () => {
  beforeEach(() => {
    clearLogs();
    setTransport((request) => fetch(request));
  });

  it('merges each read into the running boot and keeps the previous one', async () => {
    const responses = [
      { current: bootLog(0, 2), previous: bootLog(0, 1, 3) },
      { current: bootLog(1, 3), previous: bootLog(0, 1, 3) },
    ];
    let read = 0;
    setTransport(async () => {
      const body = JSON.stringify(responses[Math.min(read++, responses.length - 1)]);
      return new Response(body, { status: 200 });
    });

    await loadLogs();
    await loadLogs();

    expect(texts(currentLog.value)).toEqual(['line 0', 'line 1', 'line 2', 'line 3']);
    expect(previousLog.value && texts(previousLog.value)).toEqual(['line 0']);
    expect(previousLog.value && hiddenLines(previousLog.value)).toBe(3);
  });

  it('surfaces a failed read without discarding what it already showed', async () => {
    setTransport(
      async () => new Response(JSON.stringify({ current: bootLog(0, 2) }), { status: 200 }),
    );
    await loadLogs();
    setTransport(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    await loadLogs();

    expect(texts(currentLog.value)).toEqual(['line 0', 'line 1']);
  });
});
