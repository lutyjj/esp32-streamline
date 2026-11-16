/**
 * Firmware updates: the writes that check, install, roll back and schedule
 * them, phase words, which writes wait while an update runs, and how an
 * install ended across its restart.
 */

import * as v from 'valibot';
import {
  type Ack,
  type AutoUpdateScheduleRequest,
  type InstallResult,
  otaCheck,
  otaRollback,
  otaUpdate,
  type StatusResponse,
  setFirmware,
} from '../../generated/api';
import { RESTARTING_WRITES } from '../../generated/facts';
import { OtaUpdateRequest as installRule } from '../../generated/rules';
import { readAgain } from '../../shared/queries';
import { withAccess, withRestart } from './access';
import { type SettledRestart, status } from './device';
import { settingsQuery } from './queries';

export const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  checking: 'Checking…',
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  downloading: 'Downloading…',
  verifying: 'Verifying…',
  installed: 'Installed',
  failed: 'Failed',
};

export const UPDATE_BUSY_REASON = 'Available when the firmware update or check finishes.';

/**
 * Why the write at `path` cannot run right now, or null when it can. The
 * device refuses every write its contract marks `x-restarting` while an update
 * or check is busy.
 */
export function updateLock(path: string): string | null {
  return status.value?.ota.busy && RESTARTING_WRITES.has(path) ? UPDATE_BUSY_REASON : null;
}

export function prettyPhase(phase: string): string {
  return PHASE_LABELS[phase] || phase;
}

/**
 * Start an install: the latest release, or a custom image pinned by its
 * digest. Resolves false when the owner declines to unlock.
 */
export async function install(custom?: { url: string; sha256: string }): Promise<boolean> {
  return (await withAccess(() => otaUpdate(custom ?? {}))) !== null;
}

/** Ask the device whether a newer release exists; the status poll follows the check. */
export async function checkForUpdate(): Promise<boolean> {
  return (await withAccess(() => otaCheck())) !== null;
}

/** Restart into the previous image. */
export function rollBack(): Promise<Ack | null> {
  return withRestart('the rollback', () => otaRollback());
}

/** How often the device checks for a release by itself. */
export async function scheduleUpdates(schedule: AutoUpdateScheduleRequest): Promise<Ack | null> {
  const done = await withAccess(() => setFirmware({ auto_update_schedule: schedule }));
  if (done) await readAgain(settingsQuery);
  return done;
}

/** Why the contract refuses `value` as a custom image's address, or null. */
export function imageUrlProblem(value: string): string | null {
  return v.is(installRule.entries.url, value.trim())
    ? null
    : 'Give an http:// or https:// address without a user name or a # part.';
}

/** Why the contract refuses `value` as a custom image's digest, or null. */
export function imageDigestProblem(value: string): string | null {
  return v.is(installRule.entries.sha256, value.trim())
    ? null
    : 'A SHA-256 digest is 64 hexadecimal digits.';
}

/** How the last install ended, in words; null when none has written a slot. */
export const INSTALL_RESULT_WORDS: Record<InstallResult, string | null> = {
  none: null,
  installed: 'Finished',
  failed: 'Stopped before the restart',
  'rolled-back': 'Went back to the previous image',
};

/** How far an install has come: its phase in words, and the share written when known. */
export function installProgress(s: StatusResponse): { words: string; fraction: number | null } {
  const { phase, bytes_written: written, bytes_total: total } = s.ota;
  return {
    words: prettyPhase(phase),
    fraction: phase === 'downloading' && total > 0 ? Math.min(1, written / total) : null,
  };
}

/** How an update whose restart kept this image ended, as the device reports it. */
export function updateNews(settled: SettledRestart): { text: string; failure: boolean } {
  const now = settled.after.firmware_version;
  switch (settled.after.ota.last_result) {
    case 'rolled-back':
      return {
        text: `The new firmware did not start, so the device went back to ${now}.`,
        failure: true,
      };
    case 'failed':
      return { text: `The update did not finish, so the device still runs ${now}.`, failure: true };
    default:
      return { text: `Back online after the update, running ${now}.`, failure: false };
  }
}
