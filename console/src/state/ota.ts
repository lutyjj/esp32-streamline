/**
 * Firmware-update narration: an activity log that appends once per phase
 * change, and reboot expectations when the device goes quiet mid-install.
 */

import { effect, signal } from '@preact/signals';
import { pollFailures, status } from './device';
import { beginRebootWait, rebootWait } from './rebootWait';

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

/** Phases during which losing the device most likely means it is rebooting. */
const OTA_REBOOT_PHASES = ['downloading', 'verifying', 'installed'];

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

/** Append a line whenever the reported phase advances. */
effect(() => {
  const ota = status.value?.ota;
  if (!ota || ota.phase === 'idle' || ota.phase === loggedPhase) return;
  loggedPhase = ota.phase;
  let line = prettyPhase(ota.phase);
  const detailed = ['up-to-date', 'update-available', 'installed', 'failed'].includes(ota.phase);
  if (detailed && ota.message) line += ` — ${ota.message}`;
  logOta(line, ota.phase === 'failed' ? 'err' : ota.phase === 'installed' ? 'ok' : '');
  if (ota.phase === 'installed' && !rebootWait.value) beginRebootWait('the firmware update');
});

/** A device that vanishes mid-install is rebooting into the new image. */
effect(() => {
  if (pollFailures.value === 0) return;
  if (loggedPhase && OTA_REBOOT_PHASES.includes(loggedPhase) && !rebootWait.value) {
    beginRebootWait('the firmware update');
  }
});
