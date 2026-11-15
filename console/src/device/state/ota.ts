/**
 * Firmware-update policy: phase words, which writes wait while an update
 * runs, custom-image checks, and how an install ended across its restart.
 */

import { restartingWrite } from '../lib/contract';
import { contract, status } from './device';

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

/**
 * Phases where a loss of contact interrupts an install. Recovery observation
 * checks which firmware returns without presuming that installation succeeded.
 */
export const OTA_INSTALLING_PHASES = ['downloading', 'verifying', 'installed'];

export const UPDATE_BUSY_REASON = 'Available when the firmware update or check finishes.';

/**
 * Why the write at `path` cannot run right now, or null when it can. The
 * device refuses every write its contract marks `x-restarting` while an update
 * or check is busy; without the contract the device's own refusal stands.
 */
export function updateLock(path: string): string | null {
  const doc = contract.value;
  return status.value?.ota.busy && doc && restartingWrite(doc, path) ? UPDATE_BUSY_REASON : null;
}

export function prettyPhase(phase: string): string {
  return PHASE_LABELS[phase] || phase;
}

/** What the running session installs from; recovery narration depends on it. */
export type OtaSource = 'release' | 'custom';

/**
 * Reject a custom-image request before it leaves the browser: a blank or
 * malformed form must never fall through to a release install.
 */
export function customImageProblem(url: string, sha256: string): string | null {
  if (!url.trim() || !sha256.trim()) return 'enter both the image URL and its SHA-256';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'the image URL must be a full http(s) address';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'the image URL must use http or https';
  }
  // The device rejects these shapes too; explaining them here keeps the
  // possibly signed URL out of a device error round-trip.
  if (parsed.username || parsed.password) {
    return 'the image URL must not carry a username or password';
  }
  if (parsed.hash) {
    return 'the image URL must not carry a #fragment';
  }
  if (!/^[0-9a-f]{64}$/i.test(sha256.trim())) {
    return 'the SHA-256 must be exactly 64 hex characters';
  }
  return null;
}

/**
 * The version an install aims for. Only a release install can expect the
 * release metadata's version; a custom image's target is unknown, so its
 * recovery reads as observed rather than presumed.
 */
export function expectedVersion(source: OtaSource, latest: string): string {
  return source === 'release' ? latest : '';
}

/** How a firmware update ended, read from the versions seen across the reboot. */
export type UpdateRecovery = 'applied' | 'rolled-back' | 'inconclusive';

/**
 * Classify an update's outcome from the versions across the reboot the console
 * cannot see through. `from` ran the install, `expected` is the release aimed
 * for (empty for a digest-pinned custom image), `now` is what came back. A
 * different version means the new image booted; the version that ran the
 * install coming back while a newer one was expected means the bootloader
 * reverted; anything else — a same-version custom image — cannot be told apart.
 */
export function updateRecovery(from: string, expected: string, now: string): UpdateRecovery {
  if (now !== '' && now !== from) return 'applied';
  if (expected !== '' && expected !== from) return 'rolled-back';
  return 'inconclusive';
}
