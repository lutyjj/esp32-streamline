/**
 * Device state: the status poll, the editable settings snapshot, and the
 * derived meter/connection state every view renders from.
 */

import { computed, signal } from '@preact/signals';
import {
  type AudioProfileCatalog,
  type DeviceConfig,
  type DeviceStatus,
  getAudioProfiles,
  getContract,
  getSettings,
  getStatus,
} from '../lib/api';
import { type ApiDocument, audioProfileConstraints } from '../lib/contract';
import type { AudioProfileImportLimits } from '../lib/profiles';
import { rebootWaitTick } from './rebootWait';

export const POLL_MS = 1500;
const PEAK_HOLD_MS = 2500;

export const status = signal<DeviceStatus | null>(null);
/** Last /api/settings read; forms copy it into local edit state. */
export const config = signal<DeviceConfig | null>(null);
/** Device-owned named audio profiles, stored separately from raw settings. */
export const audioProfiles = signal<AudioProfileCatalog | null>(null);
/** The device-served OpenAPI contract; the console validates imports from it. */
export const contract = signal<ApiDocument | null>(null);
/**
 * Audio-profile import limits: structural bounds declared on the contract plus
 * the catalog schema version the device currently speaks. Both come from the
 * device, so the console never hardcodes either.
 */
export const audioProfileLimits = computed<AudioProfileImportLimits | null>(() => {
  const doc = contract.value;
  const catalog = audioProfiles.value;
  if (!doc || !catalog) return null;
  return { ...audioProfileConstraints(doc), schemaVersion: catalog.schema_version };
});
/** True when polls fail outside an expected reboot window. */
export const unreachable = signal(false);
/** Counts failed polls so subsystems (OTA) can react to the device vanishing. */
export const pollFailures = signal(0);
/** Peak-hold marks for the level meters. */
export const peakHold = signal({ left: 0, right: 0, at: 0 });
/** Packets seen on the previous poll, to tell whether audio still flows. */
let lastPackets = -1;
/** True when the packet counter moved between the last two polls. */
export const packetsMoving = signal(false);

export const setupMode = computed(() => status.value?.mode === 'setup');
/** Provisioned but no bridge configured yet: capture runs, nothing streams. */
export const noBridge = computed(
  () =>
    status.value !== null &&
    status.value.mode === 'provisioned' &&
    !status.value.target.target_host,
);

let refreshing = false;

/** One status poll; safe to call on an interval, overlaps are skipped. */
export async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await getStatus();
    applyStatus(s);
    // A recovered expected reboot just applied new settings; re-read them.
    if (rebootWaitTick(false)) loadDeviceSettings().catch(() => {});
    unreachable.value = false;
  } catch {
    pollFailures.value += 1;
    if (!rebootWaitTick(true) && status.value) unreachable.value = true;
  } finally {
    refreshing = false;
  }
}

function applyStatus(s: DeviceStatus): void {
  const now = Date.now();
  const hold = peakHold.value;
  const expired = now - hold.at > PEAK_HOLD_MS;
  const left =
    s.metrics.peak_abs_left >= hold.left || expired ? s.metrics.peak_abs_left : hold.left;
  const right =
    s.metrics.peak_abs_right >= hold.right || expired ? s.metrics.peak_abs_right : hold.right;
  peakHold.value = { left, right, at: left !== hold.left || expired ? now : hold.at };

  packetsMoving.value = lastPackets >= 0 && s.metrics.packets > lastPackets;
  lastPackets = s.metrics.packets;
  status.value = s;
  document.title = s.device_name ? `${s.device_name} — StreamLine` : 'StreamLine';
}

export async function loadConfig(): Promise<void> {
  config.value = await getSettings();
}

export async function loadAudioProfiles(): Promise<void> {
  audioProfiles.value = await getAudioProfiles();
}

export async function loadDeviceSettings(): Promise<void> {
  await Promise.all([loadConfig(), loadAudioProfiles()]);
}

/** The contract is static for a firmware build, so it loads once at startup. */
export async function loadContract(): Promise<void> {
  contract.value = await getContract();
}

/** Wire the poll loop and the initial settings read; called once from main. */
export function startPolling(): void {
  Promise.all([loadDeviceSettings(), loadContract(), refresh()]).catch(() => {
    unreachable.value = true;
  });
  setInterval(refresh, POLL_MS);
}
