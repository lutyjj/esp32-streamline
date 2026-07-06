/**
 * Startup-health policy: surface a blocking startup fault — an audio codec that
 * would not initialize — so the Overview answers "is the device usable" and
 * names the remedy. A blocking fault is not dismissible noise like clipping: it
 * stays until the device reports a clean startup again, the way an unreachable
 * device stays until it returns.
 */

import { computed } from '@preact/signals';
import type { HealthCheck } from '../lib/api';
import { setupMode, status } from './device';

/**
 * The blocking startup check to surface, or `null` when the last boot was
 * clean. Only meaningful on a provisioned device; setup mode has nothing to
 * check yet.
 */
export const blockingHealth = computed<HealthCheck | null>(() => {
  const s = status.value;
  if (!s || setupMode.value) return null;
  return s.health?.checks.find((check) => check.severity === 'blocking') ?? null;
});
