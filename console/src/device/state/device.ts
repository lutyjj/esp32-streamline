/**
 * Device state: the status poll, the editable settings snapshot, and the
 * derived meter and delivery state every view renders from.
 */

import { computed, signal } from '@preact/signals';
import { resource, settle } from '../../shared/resource';
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
import {
  type Connection,
  type ConnectionEvent,
  nextConnection,
  settledRestart,
  sightingOf,
} from './connection';

export const POLL_MS = 1500;
/**
 * A status read that has not answered by now counts as failed. A connection
 * the network silently drops never errors on its own, and while one read hangs
 * every later poll is skipped, so live indicators would freeze instead of
 * turning unavailable.
 */
export const STATUS_TIMEOUT_MS = 5000;
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

export const connection = signal<Connection>({ phase: 'opening' });
/** The device's last answer, kept through lost contact for facts a restart does not change. */
export const status = computed(() => sightingOf(connection.value)?.status ?? null);
/** The current answer; null whenever contact is lost, so live indicators turn unavailable. */
export const liveStatus = computed(() => {
  const now = connection.value;
  return now.phase === 'live' ? now.seen.status : null;
});
/** A restart the console saw finish, with the device's answers from either side of it. */
export interface SettledRestart {
  operation: string;
  before: StatusResponse | null;
  after: StatusResponse;
}

/** The latest restart the console saw finish; each one is a new object. */
export const restartSettled = signal<SettledRestart | null>(null);
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
/** Peak-hold marks for the level meters. */
export const peakHold = signal<PeakHold>({ left: 0, right: 0, at: 0 });
/** PCM bytes seen on the previous poll, to tell whether audio still flows. */
let lastPcmBytes = -1;
/** True when PCM bytes increased between the last two polls. */
export const audioMoving = signal(false);
/** Whether two answers in a row exist to compare, so `audioMoving` means something. */
export const deliveryObserved = signal(false);

/** Unconfigured: first-run onboarding owns the console. */
export const firstRun = computed(() => status.value?.mode === 'setup');
/** The device serves this console from its setup network, with capture and streaming down. */
export const onSetupNetwork = computed(() => {
  const mode = status.value?.mode;
  return mode === 'setup' || mode === 'recovery';
});
/**
 * Why the analog passthrough switch cannot move right now, or null when it can.
 * Recovery starts the codec only for a route that was on at boot, so there it
 * can turn the route off but not on.
 */
export const passthroughLocked = computed<string | null>(() => {
  const s = status.value;
  if (s?.mode === 'setup') return 'Analog passthrough is available after setup completes.';
  if (s?.mode === 'recovery' && !s.analog_passthrough.enabled) {
    return 'You can turn analog passthrough on once StreamLine is back on your Wi-Fi.';
  }
  return null;
});
/**
 * What a local analog output fault asks of the owner. Recovery cannot start a
 * codec, so there the retry waits for the home network.
 */
export function passthroughFaultAdvice(
  mode: StatusResponse['mode'] | undefined,
  enabled: boolean,
): string {
  if (mode === 'recovery') return 'StreamLine retries it once it is back on your Wi-Fi.';
  return enabled
    ? 'Turn analog passthrough off, then on again to retry.'
    : 'Turn analog passthrough on to retry.';
}
/** Provisioned but no bridge configured yet: capture runs, nothing streams. */
export const noBridge = computed(
  () =>
    status.value !== null &&
    status.value.mode === 'provisioned' &&
    !status.value.target.target_host,
);

/** Feed one observation to the connection, and re-read settings a finished restart applied. */
export function report(event: ConnectionEvent): void {
  const previous = connection.value;
  if (event.type === 'answered') observeAudio(event.status, event.at);
  else if (event.type === 'unanswered') {
    audioMoving.value = false;
    deliveryObserved.value = false;
    lastPcmBytes = -1;
  }
  const next = nextConnection(previous, event);
  connection.value = next;
  const operation = settledRestart(previous, next);
  if (operation && next.phase === 'live') {
    restartSettled.value = {
      operation,
      before: sightingOf(previous)?.status ?? null,
      after: next.seen.status,
    };
    // The restart applied settings; read them as they are now.
    void readDeviceSettings();
  }
}

let refreshing = false;

/** One status poll; safe to call on an interval, overlaps are skipped. */
export async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const answer = await getStatus({ signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    report({ type: 'answered', status: answer, at: Date.now() });
  } catch {
    report({ type: 'unanswered', at: Date.now() });
  } finally {
    refreshing = false;
  }
}

function observeAudio(s: StatusResponse, now: number): void {
  peakHold.value = nextPeakHold(
    peakHold.value,
    s.metrics.peak_abs_left,
    s.metrics.peak_abs_right,
    now,
  );
  deliveryObserved.value = lastPcmBytes >= 0;
  // A count below the last comes from a new boot, and all of it was sent since.
  const since = s.metrics.bytes_total < lastPcmBytes ? 0 : lastPcmBytes;
  audioMoving.value = lastPcmBytes >= 0 && s.metrics.bytes_total > since;
  lastPcmBytes = s.metrics.bytes_total;
}

export async function loadConfig(): Promise<void> {
  await configResource.load();
}

export async function loadAudioProfiles(): Promise<void> {
  await audioProfilesResource.load();
}

/** The contract is static for a firmware build, so it loads once at startup. */
export async function loadContract(): Promise<void> {
  await contractResource.load();
}

/** Reads a dropped read gets before its resource reports the failure. */
export const READ_ATTEMPTS = 4;
const READ_PAUSE_MS = 1000;

function pauseBetweenReads(): Promise<void> {
  return new Promise((done) => setTimeout(done, READ_PAUSE_MS));
}

/**
 * Settings and audio profiles, one read at a time, each read again when the
 * device drops it. The device keeps few connections and closes one when a
 * browser opens more.
 */
export async function readDeviceSettings(pause = pauseBetweenReads): Promise<void> {
  await settle(configResource, READ_ATTEMPTS, pause);
  await settle(audioProfilesResource, READ_ATTEMPTS, pause);
}

/**
 * Status first, then the poll, then settings, profiles and the contract in
 * turn. The poll runs beside those reads, so at most two requests are open at
 * once. Resolves with how to stop the poll once the first reads are done.
 */
export async function startPolling(pause = pauseBetweenReads): Promise<() => void> {
  await refresh();
  const poll = setInterval(refresh, POLL_MS);
  await readDeviceSettings(pause);
  await settle(contractResource, READ_ATTEMPTS, pause);
  return () => clearInterval(poll);
}
