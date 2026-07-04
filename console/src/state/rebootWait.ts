/**
 * Narration for expected reboots: while a wait is active, failed status polls
 * are normal rather than alarming, and the first successful poll announces
 * recovery. Overdue reboots warn that the device may have fallen back to its
 * setup network.
 */

import { signal } from '@preact/signals';
import { toast } from './toasts';

/** Failed polls (~1.5 s each) before warning that a reboot is overdue. */
export const REBOOT_WARN_POLLS = 40;

interface Wait {
  label: string;
  failedPolls: number;
}

export const rebootWait = signal<Wait | null>(null);

export function beginRebootWait(label: string, toastText?: string): void {
  rebootWait.value = { label, failedPolls: 0 };
  toast(
    toastText || `Restarting to apply ${label} — the console reconnects by itself`,
    'wait',
    8000,
  );
}

/** Feed one poll outcome; returns true when the tick was consumed by a wait. */
export function rebootWaitTick(pollFailed: boolean): boolean {
  const wait = rebootWait.value;
  if (!wait) return false;
  if (!pollFailed) {
    rebootWait.value = null;
    toast(`Back online — ${wait.label} applied`, 'ok');
    return true;
  }
  wait.failedPolls += 1;
  if (wait.failedPolls === REBOOT_WARN_POLLS) {
    toast(
      'Still offline after a minute — the device may have fallen back to its setup network; check your Wi-Fi list for esp32-streamline-…',
      'err',
      0,
    );
  }
  return true;
}
