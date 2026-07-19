import { useEffect, useState } from 'preact/hooks';
import type { ButtonAction, ButtonActionStatus, ButtonCapabilityStatus } from '../lib/api';
import { setButton } from '../lib/api';
import {
  BUTTON_ACTION_CHOICES,
  BUTTON_ACTION_SUMMARY,
  type ButtonRow,
  buttonRows,
  DESTRUCTIVE_ACTIONS,
} from '../lib/buttons';
import { useTransact } from '../lib/hooks';
import { loadDeviceSettings } from '../state/device';
import { Card } from './Card';
import { ActionState } from './Transact';

/**
 * Per-button action assignment for the board's advertised buttons. Absent when
 * the board wires none. Each row names the button, explains what its current
 * action does — warning when one press is destructive — and assigns another
 * through a select. Each change applies immediately and re-reads settings so
 * the control reflects the device.
 */
export function ButtonControls({
  buttons,
  actions,
  writable,
  provisioned,
}: {
  buttons: ButtonCapabilityStatus[];
  actions: ButtonActionStatus[];
  writable: boolean;
  provisioned: boolean;
}) {
  if (buttons.length === 0) return null;
  const rows = buttonRows(buttons, actions);
  return (
    <Card
      gated
      title="Buttons"
      lead="Choose what a press of each button does. Changes apply immediately."
    >
      <div class="btnlist">
        {rows.map((row) => (
          <ButtonField key={row.id} row={row} disabled={!writable || !provisioned} />
        ))}
      </div>
      {!provisioned && <p class="callout">Button control is available after setup completes.</p>}
    </Card>
  );
}

function ButtonField({ row, disabled }: { row: ButtonRow; disabled: boolean }) {
  const transact = useTransact();
  // Show the picked action at once, then reconcile from the device on reload.
  const [action, setAction] = useState<ButtonAction>(row.action);
  useEffect(() => setAction(row.action), [row.action]);

  function assign(next: ButtonAction) {
    if (next === action) return;
    setAction(next);
    transact.run(
      async () => {
        const ack = await setButton({ id: row.id, action: next });
        await loadDeviceSettings();
        return ack;
      },
      { busyText: '' },
    );
  }

  const destructive = DESTRUCTIVE_ACTIONS.has(action);
  return (
    <div class="btnrow">
      <div class="btnrow-label">
        <span class="btnrow-name">{row.label}</span>
        <span class={destructive ? 'btnrow-sub warn' : 'btnrow-sub'}>
          {BUTTON_ACTION_SUMMARY[action]}
          {destructive && ' — one press, no confirmation'}
        </span>
      </div>
      <div class="btnrow-control">
        <ActionState state={transact.state} />
        <select
          aria-label={`${row.label} action`}
          value={action}
          disabled={disabled || transact.busy}
          onChange={(e) => assign(e.currentTarget.value as ButtonAction)}
        >
          {BUTTON_ACTION_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
