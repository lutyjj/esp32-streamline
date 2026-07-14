import type { AnalogPassthroughCapabilityStatus, AnalogPassthroughStatus } from '../lib/api';
import { setAnalogPassthrough } from '../lib/api';
import { useTransact } from '../lib/hooks';
import { loadDeviceSettings } from '../state/device';
import { Toggle } from './Toggle';
import { ActionState } from './Transact';

interface AnalogPassthroughProps {
  capability?: AnalogPassthroughCapabilityStatus | null;
  status: AnalogPassthroughStatus;
  writable: boolean;
  provisioned: boolean;
}

/**
 * Capability-driven analog passthrough subsection of Input settings. The
 * switch is the state; a fault names itself and its exit in the callout.
 */
export function AnalogPassthrough({
  capability,
  status,
  writable,
  provisioned,
}: AnalogPassthroughProps) {
  const transact = useTransact();
  if (!capability) return null;

  const editable = writable && provisioned;

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
    <fieldset class="card-subsection" disabled={!editable || transact.busy}>
      <Toggle
        checked={status.enabled}
        disabled={!editable || transact.busy}
        onChange={setEnabled}
        label="Analog passthrough"
        description={`Also send the selected input to ${capability.label} through a direct analog path, at fixed line level. Streaming continues either way; changes apply immediately.`}
      />
      {!provisioned && (
        <p class="callout">Analog passthrough is available after setup completes.</p>
      )}
      {status.fault && (
        <p class="callout bad card-subsection-callout">
          {status.fault}{' '}
          {status.enabled
            ? 'Turn analog passthrough off, then on again to retry.'
            : 'Turn analog passthrough on to retry.'}
        </p>
      )}
      {transact.state.text && <ActionState state={transact.state} />}
    </fieldset>
  );
}
