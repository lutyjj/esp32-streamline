/**
 * Bridge discovery on demand: the device browses its network for about three
 * seconds (`GET /api/bridges`) and the console offers each bridge it found as
 * a stream target (`targetForm.ts` fills the form from one).
 */

import { computed } from '@preact/signals';
import { type DiscoveredBridge, getBridges } from '../../generated/api';
import { status } from './device';

/** The device browses only from the home network; the setup network offers the form alone. */
export const searchOffered = computed(() => status.value?.mode === 'provisioned');

/** Browse once, for the bridges that answered. */
export async function findBridges(): Promise<DiscoveredBridge[]> {
  return (await getBridges()).bridges;
}

/** The bridge console address a bridge advertises, or '' when it advertises none. */
export function bridgeConsoleAddress(bridge: DiscoveredBridge): string {
  return bridge.http_port ? `http://${bridge.host}:${bridge.http_port}/` : '';
}
