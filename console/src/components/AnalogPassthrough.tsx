import type { AnalogPassthroughCapabilityStatus, AnalogPassthroughStatus } from '../lib/api';
import { setAnalogPassthrough } from '../lib/api';
import { useTransact } from '../lib/hooks';
import { status as device, loadDeviceSettings, passthroughFaultAdvice } from '../state/device';
import { Toggle } from './Toggle';
import { ActionState } from './Transact';

/**
 * The analog passthrough switch with its own transaction and fault callout —
 * the one control for the route, shared by the Input settings subsection and
 * the input setup guide. The switch is the state; a fault names its exit.
 */
export function AnalogPassthroughToggle({
  capability,
  status,
  disabled,
}: {
  capability: AnalogPassthroughCapabilityStatus;
  status: AnalogPassthroughStatus;
  disabled: boolean;
}) {
  const transact = useTransact();

  function setEnabled(enabled: boolean) {
    transact.run(
      async () => {
        const ack = await setAnalogPassthrough({ enabled });
        await loadDeviceSettings();
        return ack;
      },
      {
        busyText: enabled ? 'Turning on…' : 'Turning off…',
        okText: enabled ? 'Analog passthrough is active' : 'Analog passthrough is off',
      },
    );
  }

  return (
    <>
      <Toggle
        checked={status.enabled}
        disabled={disabled || transact.busy}
        onChange={setEnabled}
        label="Analog passthrough"
        description={`Also send the selected input to ${capability.label} through a direct analog path, at fixed line level. Streaming continues either way; changes apply immediately.`}
      />
      {status.fault && (
        <p class="callout bad section-subsection-callout">
          {status.fault} {passthroughFaultAdvice(device.value?.mode, status.enabled)}
        </p>
      )}
      {transact.state.text && <ActionState state={transact.state} />}
    </>
  );
}

/** Capability-driven analog passthrough subsection of Input settings. */
export function AnalogPassthrough({
  capability,
  status,
  writable,
  locked,
}: {
  capability?: AnalogPassthroughCapabilityStatus | null;
  status: AnalogPassthroughStatus;
  writable: boolean;
  /** Why the switch cannot move right now; null when it can. */
  locked: string | null;
}) {
  if (!capability) return null;
  return (
    <fieldset class="section-subsection" disabled={!writable || Boolean(locked)}>
      <AnalogPassthroughToggle
        capability={capability}
        status={status}
        disabled={!writable || Boolean(locked)}
      />
      {locked && <p class="callout">{locked}</p>}
    </fieldset>
  );
}
