/**
 * Bridge discovery on demand: the device browses its network for about three
 * seconds (`GET /api/bridges`) and the console offers each bridge it found as
 * a stream target. Using one fills the target fields; only a save writes them.
 */

import { signal } from '@preact/signals';
import { type DiscoveredBridge, getBridges } from '../lib/api';
import { errorMessage } from '../lib/errors';

export type Discovery =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | { phase: 'found'; bridges: DiscoveredBridge[] }
  | { phase: 'failed'; reason: string };

/** A browse takes three seconds; this covers it plus a queued request ahead of it. */
export const DISCOVERY_DEADLINE_MS = 10_000;

export const discovery = signal<Discovery>({ phase: 'idle' });

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

/** Whether the target fields already name this bridge. */
export function fillsTarget(bridge: DiscoveredBridge, host: string, port: string): boolean {
  return host.trim() === bridge.host && Number(port) === bridge.port;
}

/** The bridge console address a bridge advertises, or '' when it advertises none. */
export function bridgeConsoleAddress(bridge: DiscoveredBridge): string {
  return bridge.http_port ? `http://${bridge.host}:${bridge.http_port}/` : '';
}

/**
 * The console address Use fills in, or null to keep the field: the bridge's
 * own replaces an empty field or one an earlier Use filled (`filled`), never
 * an address the owner typed.
 */
export function consoleAddressAfterUse(
  current: string,
  filled: string,
  bridge: DiscoveredBridge,
): string | null {
  return current === '' || current === filled ? bridgeConsoleAddress(bridge) : null;
}
