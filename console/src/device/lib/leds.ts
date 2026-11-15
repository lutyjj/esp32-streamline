import type { LedCapabilityStatus, LedRole, LedRoleStatus } from './api';

export interface LedRow {
  id: string;
  label: string;
  role: LedRole;
}

/**
 * Pair each board LED with its effective role, in descriptor order. The device
 * returns a role for every LED, so this normally just zips the two lists; a
 * missing entry falls back to the LED's descriptor default so a row never
 * renders blank.
 */
export function ledRows(leds: LedCapabilityStatus[], roles: LedRoleStatus[]): LedRow[] {
  const roleById = new Map(roles.map((entry) => [entry.id, entry.role]));
  return leds.map((led) => ({
    id: led.id,
    label: led.label,
    role: roleById.get(led.id) ?? led.default_role,
  }));
}

/** The assignable roles in display order, with the label the console shows. */
export const LED_ROLE_CHOICES: { value: LedRole; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** One-line description of what each role does, shown under the LED name. */
export const LED_ROLE_SUMMARY: Record<LedRole, string> = {
  status: 'Follows the device state',
  on: 'Always lit',
  off: 'Always dark',
};
