/**
 * Device state: the status poll, the editable settings snapshot, and the
 * derived meter/connection state every view renders from.
 */

import { computed, signal } from '@preact/signals';
import {
  type AudioProfileCatalog,
  getAudioProfiles,
  getContract,
  getSettings,
  getStatus,
  type SettingsResponse,
  type StatusResponse,
} from '../lib/api';
import { type ApiDocument, audioProfileConstraints } from '../lib/contract';
import type { AudioProfileImportLimits } from '../lib/profiles';
import { resource } from '../lib/resource';
import { rebootWaitTick } from './rebootWait';
import { resetHandoff } from './resetHandoff';

export const POLL_MS = 1500;
export const PEAK_HOLD_MS = 2500;

export interface PeakHold {
  left: number;
  right: number;
  at: number;
}

/** Hold both channel peaks from the most recent rise for the full hold window. */
export function nextPeakHold(
  hold: PeakHold,
  leftSample: number,
  rightSample: number,
  now: number,
): PeakHold {
  const expired = now - hold.at > PEAK_HOLD_MS;
  const left = leftSample >= hold.left || expired ? leftSample : hold.left;
  const right = rightSample >= hold.right || expired ? rightSample : hold.right;
  const rose = left !== hold.left || right !== hold.right;
  return { left, right, at: rose || expired ? now : hold.at };
}

export const status = signal<StatusResponse | null>(null);
/** Last /api/settings read; forms copy it into local edit state. */
export const configResource = resource<SettingsResponse>('device settings', getSettings);
export const config = configResource.data;
/** Device-owned named audio profiles, stored separately from raw settings. */
export const audioProfilesResource = resource<AudioProfileCatalog>(
  'audio profiles',
  getAudioProfiles,
);
export const audioProfiles = audioProfilesResource.data;
/** The device-served OpenAPI contract; the console validates imports from it. */
export const contractResource = resource<ApiDocument>('the device contract', getContract);
export const contract = contractResource.data;
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
export const peakHold = signal<PeakHold>({ left: 0, right: 0, at: 0 });
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

/**
 * The bridge link as one word, derived once so the Overview tile and the setup
 * wizard narrate the same state and cannot drift. `sending` means packets moved
 * between the last two polls — the observable proof audio reaches the bridge.
 */
export type BridgeConnection = 'setup' | 'unset' | 'idle' | 'connecting' | 'sending';
export const bridgeConnection = computed<BridgeConnection>(() => {
  const s = status.value;
  if (!s) return 'unset';
  if (s.mode === 'setup') return 'setup';
  if (!s.target.target_host) return 'unset';
  if (packetsMoving.value) return 'sending';
  return s.metrics.playing ? 'connecting' : 'idle';
});

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
    if (!rebootWaitTick(true) && status.value && !resetHandoff.value) unreachable.value = true;
  } finally {
    refreshing = false;
  }
}

function applyStatus(s: StatusResponse): void {
  const now = Date.now();
  peakHold.value = nextPeakHold(
    peakHold.value,
    s.metrics.peak_abs_left,
    s.metrics.peak_abs_right,
    now,
  );

  packetsMoving.value = lastPackets >= 0 && s.metrics.packets > lastPackets;
  lastPackets = s.metrics.packets;
  status.value = s;
  document.title = s.device_name ? `${s.device_name} — StreamLine` : 'StreamLine';
}

export async function loadConfig(): Promise<void> {
  await configResource.load();
}

export async function loadAudioProfiles(): Promise<void> {
  await audioProfilesResource.load();
}

export async function loadDeviceSettings(): Promise<void> {
  await Promise.all([loadConfig(), loadAudioProfiles()]);
}

/** The contract is static for a firmware build, so it loads once at startup. */
export async function loadContract(): Promise<void> {
  await contractResource.load();
}

/**
 * Wire the poll loop and the initial settings read; called once from main.
 * Each resource fails independently and retries from its own notice — a
 * failed settings read never hides the status the poll can still deliver.
 */
export function startPolling(): void {
  void loadDeviceSettings();
  void loadContract();
  refresh().catch(() => {
    unreachable.value = true;
  });
  setInterval(refresh, POLL_MS);
}
