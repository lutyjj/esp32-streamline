import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginRebootWait,
  REBOOT_OVERDUE_TEXT,
  REBOOT_SETTLE_MS,
  REBOOT_WARN_POLLS,
  rebootOverdue,
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
    rebootWaitTick(true); // the device dropped for the reboot
    expect(rebootWaitTick(false)).toBe(true);
    expect(rebootWait.value).toBeNull();
    expect(toasts.value.map((t) => t.text)).toEqual(['Back online — the restart applied']);
  });

  it('hands recovery to onRecover instead of the default applied line', () => {
    let recovered = 0;
    beginRebootWait('the firmware update', undefined, () => {
      recovered += 1;
    });
    toasts.value = [];
    rebootWaitTick(true); // the device dropped for the reboot
    expect(rebootWaitTick(false)).toBe(true);
    expect(recovered).toBe(1);
    // The presumptuous default toast must not also fire.
    expect(toasts.value).toEqual([]);
  });

  it('ignores a success before the device drops so a pre-reboot poll is not read as recovery', () => {
    let recovered = 0;
    beginRebootWait('the firmware update', undefined, () => {
      recovered += 1;
    });
    toasts.value = [];
    // The device stamped its new phase (e.g. OTA `installed`) but still serves
    // the old image; this poll succeeds before the reboot. Recovery must wait.
    expect(rebootWaitTick(false)).toBe(true);
    expect(rebootWait.value).not.toBeNull();
    expect(recovered).toBe(0);
    expect(toasts.value).toEqual([]);
    // The real reboot: polls fail, then the device returns and recovery fires.
    rebootWaitTick(true);
    expect(rebootWaitTick(false)).toBe(true);
    expect(recovered).toBe(1);
  });

  it('recovers past the settle window even if no poll caught the downtime', () => {
    beginRebootWait('encrypted streaming');
    toasts.value = [];
    // A fast reboot or a backgrounded tab: the poller never observed an offline
    // poll, but enough time has passed that a reachable device means it rebooted.
    const wait = rebootWait.value;
    if (wait) wait.startedAt = Date.now() - (REBOOT_SETTLE_MS + 1);

    expect(rebootWaitTick(false)).toBe(true);
    expect(rebootWait.value).toBeNull();
    expect(toasts.value.map((t) => t.text)).toEqual(['Back online — encrypted streaming applied']);
  });

  it('warns once the reboot is overdue and stops hiding lost contact', () => {
    beginRebootWait('the factory reset');
    toasts.value = [];
    for (let i = 1; i < REBOOT_WARN_POLLS; i += 1) expect(rebootWaitTick(true)).toBe(true);
    expect(rebootOverdue.value).toBe(false);

    expect(rebootWaitTick(true)).toBe(false);
    expect(rebootOverdue.value).toBe(true);
    expect(toasts.value.map((t) => t.text)).toEqual([REBOOT_OVERDUE_TEXT]);
    // A late return still ends the wait.
    expect(rebootWaitTick(false)).toBe(true);
    expect(rebootWait.value).toBeNull();
  });

  it('does nothing outside a wait', () => {
    expect(rebootWaitTick(true)).toBe(false);
    expect(rebootWaitTick(false)).toBe(false);
  });
});
