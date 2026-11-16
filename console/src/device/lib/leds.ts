import type { LedCapabilityStatus, LedRole, LedRoleStatus } from '../../generated/api';

export interface LedRow {
  id: string;
  label: string;
  role: LedRole;
}

/**
 * Pair each board LED with its effective role, in descriptor order. Labels
 * come from the status and roles from the settings, which a board change can
 * leave a read apart, so a LED the settings do not name yet shows its
 * descriptor default.
 */
export function ledRows(leds: LedCapabilityStatus[], roles: LedRoleStatus[]): LedRow[] {
  const roleById = new Map(roles.map((entry) => [entry.id, entry.role]));
  return leds.map((led) => ({
    id: led.id,
    label: led.label,
    role: roleById.get(led.id) ?? led.default_role,
  }));
}

/** What each role is called and does, in the order the console offers them. */
export const LED_ROLES: Record<LedRole, { label: string; summary: string }> = {
  status: { label: 'Status', summary: 'Follows what the device is doing.' },
  on: { label: 'On', summary: 'Always lit.' },
  off: { label: 'Off', summary: 'Always dark.' },
};
