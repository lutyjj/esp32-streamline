/**
 * Firmware-update policy: phase words, which writes wait while an update
 * runs, and how an install ended across its restart.
 */

import { otaUpdate, type StatusResponse } from '../../generated/api';
import { RESTARTING_WRITES } from '../../generated/facts';
import { withAccess } from './access';
import { type SettledRestart, status } from './device';

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

/** How far an install has come: its phase in words, and the share written when known. */
export function installProgress(s: StatusResponse): { words: string; fraction: number | null } {
  const { phase, bytes_written: written, bytes_total: total } = s.ota;
  return {
    words: prettyPhase(phase),
    fraction: phase === 'downloading' && total > 0 ? Math.min(1, written / total) : null,
  };
}

/** What an update's restart turned out to be, as the device reports the install's end. */
export function updateNews(settled: SettledRestart): { text: string; failure: boolean } {
  const now = settled.after.firmware_version;
  switch (settled.after.ota.last_result) {
    case 'installed':
      return { text: `Updated to ${now}.`, failure: false };
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
