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
  /** Owns the recovery message when the default "applied" line would presume
   *  too much — an update that may have rolled back narrates its own outcome. */
  onRecover?: () => void;
}

export const rebootWait = signal<Wait | null>(null);

export function beginRebootWait(label: string, toastText?: string, onRecover?: () => void): void {
  rebootWait.value = { label, failedPolls: 0, onRecover };
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
    // A success before any poll has failed means the device has not rebooted
    // yet: it stamped the new phase (e.g. an OTA reporting `installed`) but is
    // still serving the old image. Keep waiting so recovery is classified from
    // the post-reboot state, not the pre-reboot one that looks like a rollback.
    if (wait.failedPolls === 0) return true;
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
