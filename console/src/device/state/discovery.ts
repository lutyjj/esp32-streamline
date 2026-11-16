/**
 * Bridge discovery on demand: the device browses its network for about three
 * seconds (`GET /api/bridges`) and the console offers each bridge it found as
 * a stream target (`targetForm.ts` fills the form from one).
 */

import { computed, signal } from '@preact/signals';
import { type DiscoveredBridge, getBridges } from '../../generated/api';
import { errorMessage } from '../../shared/errors';
import { status } from './device';

export type Discovery =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | { phase: 'found'; bridges: DiscoveredBridge[] }
  | { phase: 'failed'; reason: string };

/** A browse takes three seconds; this covers it plus a queued request ahead of it. */
export const DISCOVERY_DEADLINE_MS = 10_000;

export const discovery = signal<Discovery>({ phase: 'idle' });

/** The device browses only from the home network; the setup network offers the form alone. */
export const searchOffered = computed(() => status.value?.mode === 'provisioned');

let inflight: Promise<void> | null = null;

/** Browse once. A caller during a running search shares that search. */
export function findBridges(): Promise<void> {
  inflight ??= search().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function search(): Promise<void> {
  discovery.value = { phase: 'searching' };
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(`the device did not answer within ${DISCOVERY_DEADLINE_MS / 1000} seconds`),
      ),
    DISCOVERY_DEADLINE_MS,
  );
  try {
    const { bridges } = await getBridges({ signal: deadline.signal });
    discovery.value = { phase: 'found', bridges };
  } catch (cause) {
    discovery.value = { phase: 'failed', reason: errorMessage(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/** The bridge console address a bridge advertises, or '' when it advertises none. */
export function bridgeConsoleAddress(bridge: DiscoveredBridge): string {
  return bridge.http_port ? `http://${bridge.host}:${bridge.http_port}/` : '';
}
