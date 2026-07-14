import { useEffect, useState } from 'preact/hooks';
import type { LedCapabilityStatus, LedRole, LedRoleStatus } from '../lib/api';
import { setLed } from '../lib/api';
import { useTransact } from '../lib/hooks';
import { LED_ROLE_CHOICES, LED_ROLE_SUMMARY, type LedRow, ledRows } from '../lib/leds';
import { loadDeviceSettings } from '../state/device';
import { Card } from './Card';
import { Segmented } from './Segmented';
import { ActionState } from './Transact';

/**
 * Per-LED role assignment for the board's advertised LEDs. Absent when the
 * board wires none. A preview dot shows what each LED is doing (dark, lit, or
 * pulsing for status) and a segmented control assigns the role. Each change
 * applies immediately and re-reads settings so the control reflects the device.
 */
export function LedControls({
  leds,
  roles,
  writable,
  provisioned,
}: {
  leds: LedCapabilityStatus[];
  roles: LedRoleStatus[];
  writable: boolean;
  provisioned: boolean;
}) {
  if (leds.length === 0) return null;
  const rows = ledRows(leds, roles);
  return (
    <Card gated title="LEDs" lead="Choose what each LED shows. Changes apply immediately.">
      <div class="ledlist">
        {rows.map((row) => (
          <LedField key={row.id} row={row} disabled={!writable || !provisioned} />
        ))}
      </div>
      {!provisioned && <p class="callout">LED control is available after setup completes.</p>}
    </Card>
  );
}

function LedField({ row, disabled }: { row: LedRow; disabled: boolean }) {
  const transact = useTransact();
  // Show the picked role at once, then reconcile from the device on reload.
  const [role, setRole] = useState<LedRole>(row.role);
  useEffect(() => setRole(row.role), [row.role]);

  function assign(next: LedRole) {
    if (next === role) return;
    setRole(next);
    transact.run(
      async () => {
        const ack = await setLed({ id: row.id, role: next });
        await loadDeviceSettings();
        return ack;
      },
      { busyText: '' },
    );
  }

  return (
    <div class="ledrow">
      <span class={`leddot leddot-${role}`} aria-hidden="true" />
      <div class="ledrow-label">
        <span class="ledrow-name">{row.label}</span>
        <span class="ledrow-sub">{LED_ROLE_SUMMARY[role]}</span>
      </div>
      <div class="ledrow-control">
        <ActionState state={transact.state} />
        <Segmented
          name={`led-${row.id}`}
          ariaLabel={`${row.label} behavior`}
          value={role}
          options={LED_ROLE_CHOICES}
          disabled={disabled || transact.busy}
          onChange={assign}
        />
      </div>
    </div>
  );
}
