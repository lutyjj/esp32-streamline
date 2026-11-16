/**
 * Health policy. A blocking startup fault, such as an audio codec that would
 * not initialize, is surfaced so the Overview answers "is the device usable"
 * and names the remedy. It is not dismissible noise like clipping: it stays
 * until the device reports a clean startup again, the way an unreachable
 * device stays until it returns. Memory and storage turn tight, then nearly
 * out, as they fill.
 */

import { computed } from '@preact/signals';
import type { HealthCheck } from '../../generated/api';
import { onSetupNetwork, status } from './device';

/**
 * The blocking startup check to surface, or `null` when the last boot was
 * clean. Only meaningful on a provisioned device; setup mode has nothing to
 * check yet.
 */
export const blockingHealth = computed<HealthCheck | null>(() => {
  const s = status.value;
  if (!s || onSetupNetwork.value) return null;
  return s.health?.checks.find((check) => check.severity === 'blocking') ?? null;
});

/** Where a resource of `total` turns tight (past four fifths used) and nearly out (past 95%). */
export function headroomZones(total: number) {
  return [
    { from: total * 0.8, to: total * 0.95, tone: 'warn' },
    { from: total * 0.95, to: total, tone: 'danger' },
  ] as const;
}
