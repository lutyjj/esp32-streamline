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

/**
 * A success with no failed poll yet can mean the device has not gone down: it
 * stamped the new phase (an OTA reporting `installed`, a save writing the new
 * config) but still serves the old image. Ignore such a success only inside
 * this grace window; past it, a reachable device means the reboot completed —
 * a poll can otherwise miss the whole downtime (fast reboot, backgrounded tab)
 * and the wait would hang forever.
 */
export const REBOOT_SETTLE_MS = 4000;

interface Wait {
  label: string;
  failedPolls: number;
  startedAt: number;
  /** Owns the recovery message when the default "applied" line would presume
   *  too much — an update that may have rolled back narrates its own outcome. */
  onRecover?: () => void;
}

export const rebootWait = signal<Wait | null>(null);

export function beginRebootWait(label: string, toastText?: string, onRecover?: () => void): void {
  rebootWait.value = { label, failedPolls: 0, startedAt: Date.now(), onRecover };
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
    if (wait.failedPolls === 0 && Date.now() - wait.startedAt < REBOOT_SETTLE_MS) return true;
    rebootWait.value = null;
    if (wait.onRecover) wait.onRecover();
    else toast(`Back online — ${wait.label} applied`, 'ok');
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
