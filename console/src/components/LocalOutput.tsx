import type { AnalogPassthroughCapabilityStatus, AnalogPassthroughStatus } from '../lib/api';
import { setAnalogPassthrough } from '../lib/api';
import { useTransact } from '../lib/hooks';
import { loadDeviceSettings } from '../state/device';
import { Chip } from './Chip';
import { ActionState } from './Transact';

interface LocalOutputProps {
  capability?: AnalogPassthroughCapabilityStatus | null;
  status: AnalogPassthroughStatus;
  writable: boolean;
  provisioned: boolean;
}

/** Capability-driven output route embedded in the input settings form. */
export function LocalOutput({ capability, status, writable, provisioned }: LocalOutputProps) {
  const transact = useTransact();
  if (!capability) return null;

  const state = status.fault
    ? 'Fault'
    : status.active
      ? 'Active'
      : status.enabled
        ? 'Unavailable'
        : 'Off';
  const tone = status.fault ? 'bad' : status.active ? 'good' : status.enabled ? 'warn' : 'neutral';
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
        okText: enabled ? 'Local output is active' : 'Local output is off',
      },
    );
  }

  return (
    <fieldset class="local-output" disabled={!editable || transact.busy}>
      <legend>
        Output route
        <Chip tone={tone} dot>
          {state}
        </Chip>
      </legend>
      <div class="local-output-choices">
        <label class="choice local-output-choice">
          <input
            type="radio"
            name="local-output-mode"
            value="streaming"
            checked={!status.enabled && !status.fault}
            onInput={() => setEnabled(false)}
          />
          <span class="local-output-copy">
            <strong>Streaming only</strong>
            <small>Keep the local output off.</small>
          </span>
        </label>
        <label class="choice local-output-choice">
          <input
            type="radio"
            name="local-output-mode"
            value="streaming-and-local"
            checked={status.enabled}
            onInput={() => setEnabled(true)}
          />
          <span class="local-output-copy">
            <strong>Streaming + local output</strong>
            <small>
              Also send the selected input to {capability.label} through a direct analog path.
            </small>
          </span>
        </label>
      </div>
      <p class="local-output-note">
        Route changes apply immediately. The selected source feeds both paths. Local output is fixed
        at line level; gain, ADC attenuation, calibration, and silence detection affect streaming
        only.
      </p>
      {!provisioned && <p class="callout">Local output is available after setup completes.</p>}
      {status.fault && (
        <p class="callout bad local-output-callout">
          {status.fault}{' '}
          {status.enabled
            ? 'Choose Streaming only to turn the route off.'
            : 'Choose Streaming only to retry.'}
        </p>
      )}
      {transact.state.text && <ActionState state={transact.state} />}
    </fieldset>
  );
}
