import { setStream } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { bridgeConnection, noBridge, status, unreachable } from '../state/device';
import { blockingHealth } from '../state/health';
import { Button } from './Button';
import { ActionState, TransactButton } from './Transact';

export function AudioDelivery({ onSetupBridge }: { onSetupBridge: () => void }) {
  const s = status.value;
  const writable = useWritable();
  const transact = useTransact();
  if (!s)
    return (
      <div class="delivery-status">
        {unreachable.value
          ? 'Device unavailable. Check your network; this page retries automatically.'
          : 'Connecting to your device…'}
      </div>
    );
  const fault = blockingHealth.value;
  const paused = !s.stream.enabled;
  const label = unreachable.value
    ? 'Device unavailable'
    : fault
      ? 'Audio needs attention'
      : paused
        ? 'Paused'
        : noBridge.value
          ? 'No audio destination'
          : bridgeConnection.value === 'sending'
            ? 'Sending audio'
            : s.metrics.playing
              ? 'Connecting to bridge'
              : 'Input is quiet';
  return (
    <div class="delivery-status">
      <div>
        <strong>{label}</strong>
        <p>
          {unreachable.value
            ? 'Live readings are paused. Reconnecting automatically.'
            : fault
              ? `${fault.detail} ${fault.remedy ?? ''}`
              : paused
                ? 'Streaming is paused. The input meter stays live.'
                : noBridge.value
                  ? 'Connect a bridge to make this input available to your player.'
                  : bridgeConnection.value === 'sending'
                    ? `To ${s.target.target_host}. Open your bridge to verify reception and get the playback URL.`
                    : 'Play your source to check its input signal and transmission.'}
        </p>
      </div>
      {!unreachable.value &&
        (noBridge.value ? (
          <Button disabled={!writable} onClick={onSetupBridge}>
            Connect a bridge
          </Button>
        ) : (
          <TransactButton
            kind="secondary"
            transact={transact}
            disabled={!writable}
            onClick={() =>
              transact.run(() => setStream({ enabled: paused }), {
                busyText: paused ? 'Resuming…' : 'Pausing…',
                okText: paused ? 'Streaming resumed' : 'Streaming paused',
              })
            }
          >
            {paused ? 'Resume' : 'Pause sending'}
          </TransactButton>
        ))}
      <ActionState state={transact.state} />
    </div>
  );
}
