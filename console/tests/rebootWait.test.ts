import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginRebootWait,
  REBOOT_WARN_POLLS,
  rebootWait,
  rebootWaitTick,
} from '../src/state/rebootWait';
import { toasts } from '../src/state/toasts';

beforeEach(() => {
  rebootWait.value = null;
  toasts.value = [];
});

describe('reboot-wait narration', () => {
  it('consumes failed polls while a reboot is expected', () => {
    beginRebootWait('the network settings');
    expect(rebootWaitTick(true)).toBe(true);
    expect(rebootWait.value?.failedPolls).toBe(1);
  });

  it('announces recovery once and ends the wait', () => {
    beginRebootWait('the restart');
    toasts.value = [];
    expect(rebootWaitTick(false)).toBe(true);
    expect(rebootWait.value).toBeNull();
    expect(toasts.value.map((t) => t.text)).toEqual(['Back online — the restart applied']);
  });

  it('warns when the reboot is overdue', () => {
    beginRebootWait('the factory reset');
    toasts.value = [];
    for (let i = 0; i < REBOOT_WARN_POLLS; i += 1) rebootWaitTick(true);
    expect(toasts.value.some((t) => t.text.includes('Still offline'))).toBe(true);
  });

  it('does nothing outside a wait', () => {
    expect(rebootWaitTick(true)).toBe(false);
    expect(rebootWaitTick(false)).toBe(false);
  });
});
