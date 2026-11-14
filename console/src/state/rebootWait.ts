/**
 * Narration for expected reboots: while a wait is active, failed status polls
 * are normal rather than alarming, and the first successful poll announces
 * recovery. Once a wait is overdue, failed polls count as lost contact again.
 * An overdue reboot warns that the device may have fallen back to its setup
 * network; one from recovery leaves the lost contact to the recovery banner.
 */

import { computed, signal } from '@preact/signals';
import type { StatusResponse } from '../lib/api';
import { toast } from './toasts';

/** Failed polls (~1.5 s each) before a reboot is overdue. */
export const REBOOT_WARN_POLLS = 40;

/** What every surface that narrated the restart says once it is overdue. */
export const REBOOT_OVERDUE_TEXT =
  'Still offline after a minute. The device may have fallen back to its setup network; check your Wi-Fi list for esp32-streamline-….';

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

/** True while a wait runs past the point a restart should have finished. */
export const rebootOverdue = computed(
  () => (rebootWait.value?.failedPolls ?? 0) >= REBOOT_WARN_POLLS,
);

export function beginRebootWait(label: string, toastText?: string, onRecover?: () => void): void {
  rebootWait.value = { label, failedPolls: 0, startedAt: Date.now(), onRecover };
  toast(
    toastText || `Restarting to apply ${label} — the console reconnects by itself`,
    'wait',
    8000,
  );
}

/**
 * Feed one poll outcome and the mode the device last reported; returns true
 * when the tick was consumed by a wait. An overdue wait no longer explains a
 * failed poll, and a late return still ends it. A reboot from recovery can end
 * on the home network, out of this browser's reach, so the recovery banner
 * tells that story instead of the overdue warning.
 */
export function rebootWaitTick(pollFailed: boolean, mode?: StatusResponse['mode']): boolean {
  const wait = rebootWait.value;
  if (!wait) return false;
  if (!pollFailed) {
    if (wait.failedPolls === 0 && Date.now() - wait.startedAt < REBOOT_SETTLE_MS) return true;
    rebootWait.value = null;
    if (wait.onRecover) wait.onRecover();
    else toast(`Back online — ${wait.label} applied`, 'ok');
    return true;
  }
  const failedPolls = wait.failedPolls + 1;
  rebootWait.value = { ...wait, failedPolls };
  if (failedPolls === REBOOT_WARN_POLLS && mode !== 'recovery') {
    toast(REBOOT_OVERDUE_TEXT, 'err', 0);
  }
  return failedPolls < REBOOT_WARN_POLLS;
}
