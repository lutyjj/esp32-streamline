/**
 * Firmware-update narration: an activity log that appends once per phase
 * change, and reboot expectations when the device goes quiet mid-install.
 */

import { effect, signal } from '@preact/signals';
import { pollFailures, status } from './device';
import { beginRebootWait, rebootWait } from './rebootWait';
import { toast } from './toasts';

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
 * Phases while an install is under way. A device that stops answering in one
 * of these is rebooting into the new image.
 */
export const OTA_INSTALLING_PHASES = ['downloading', 'verifying', 'installed'];

export function prettyPhase(phase: string): string {
  return PHASE_LABELS[phase] || phase;
}

export interface OtaLogLine {
  at: string;
  text: string;
  cls: '' | 'ok' | 'err';
}

export const otaLog = signal<OtaLogLine[]>([]);

let loggedPhase: string | null = null;

export function logOta(text: string, cls: OtaLogLine['cls'] = ''): void {
  otaLog.value = [...otaLog.value, { at: new Date().toLocaleTimeString(), text, cls }];
}

/** Reset the log when the user starts a check or install. */
export function beginOtaSession(line: string): void {
  otaLog.value = [];
  loggedPhase = null;
  logOta(line);
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

/** The version that ran the install and the release it aimed for, captured
 *  when the reboot wait arms so recovery can be classified. */
let pendingUpdate: { from: string; expected: string } | null = null;

/** Arm the reboot wait for an install, remembering the versions so recovery
 *  narrates the true outcome instead of presuming success. */
function beginUpdateRebootWait(): void {
  const s = status.value;
  pendingUpdate = {
    from: s?.firmware_version ?? '',
    expected: s?.ota.latest_version ?? '',
  };
  beginRebootWait('the firmware update', undefined, narrateUpdateRecovery);
}

/** Runs on the first successful poll after an install: say what actually
 *  happened — applied, rolled back, or the same version returned. */
function narrateUpdateRecovery(): void {
  const pending = pendingUpdate;
  pendingUpdate = null;
  const now = status.value?.firmware_version ?? '';
  const outcome = pending ? updateRecovery(pending.from, pending.expected, now) : 'applied';
  if (outcome === 'rolled-back' && pending) {
    logOta(
      `Update rolled back — the new image did not boot; running v${pending.from} again`,
      'err',
    );
    // Sticky: a silent revert is exactly the surprise the journey must narrate.
    toast(`Update rolled back — the device reverted to v${pending.from}`, 'err', 0);
    return;
  }
  const version = now || pending?.from || '';
  logOta(version ? `Back online — running v${version}` : 'Back online', 'ok');
  toast(version ? `Back online — running v${version}` : 'Back online — update applied', 'ok');
}

/** Append a line whenever the reported phase advances. */
effect(() => {
  const ota = status.value?.ota;
  if (!ota || ota.phase === 'idle' || ota.phase === loggedPhase) return;
  loggedPhase = ota.phase;
  let line = prettyPhase(ota.phase);
  const detailed = ['up-to-date', 'update-available', 'installed', 'failed'].includes(ota.phase);
  if (detailed && ota.message) line += ` — ${ota.message}`;
  logOta(line, ota.phase === 'failed' ? 'err' : ota.phase === 'installed' ? 'ok' : '');
  if (ota.phase === 'installed' && !rebootWait.value) beginUpdateRebootWait();
});

/** A device that vanishes mid-install is rebooting into the new image. */
effect(() => {
  if (pollFailures.value === 0) return;
  if (loggedPhase && OTA_INSTALLING_PHASES.includes(loggedPhase) && !rebootWait.value) {
    beginUpdateRebootWait();
  }
});
