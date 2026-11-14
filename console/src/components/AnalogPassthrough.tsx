import type {
  AnalogPassthroughCapabilityStatus,
  AnalogPassthroughStatus,
  DeviceMode,
} from '../lib/api';
import { setAnalogPassthrough } from '../lib/api';
import { useTransact } from '../lib/hooks';
import { loadDeviceSettings } from '../state/device';
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
          {status.fault}{' '}
          {status.enabled
            ? 'Turn analog passthrough off, then on again to retry.'
            : 'Turn analog passthrough on to retry.'}
        </p>
      )}
      {transact.state.text && <ActionState state={transact.state} />}
    </>
  );
}

/** Why the switch waits while the device is on its setup network. */
const WAITS_FOR: Partial<Record<DeviceMode, string>> = {
  setup: 'Analog passthrough is available after setup completes.',
  recovery: 'You can change analog passthrough once StreamLine is back on your Wi-Fi.',
};

/** Capability-driven analog passthrough subsection of Input settings. */
export function AnalogPassthrough({
  capability,
  status,
  writable,
  mode,
}: {
  capability?: AnalogPassthroughCapabilityStatus | null;
  status: AnalogPassthroughStatus;
  writable: boolean;
  mode: DeviceMode;
}) {
  if (!capability) return null;
  const waits = WAITS_FOR[mode];
  return (
    <fieldset class="section-subsection" disabled={!writable || Boolean(waits)}>
      <AnalogPassthroughToggle
        capability={capability}
        status={status}
        disabled={!writable || Boolean(waits)}
      />
      {waits && <p class="callout">{waits}</p>}
    </fieldset>
  );
}
