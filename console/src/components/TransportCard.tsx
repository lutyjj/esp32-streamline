import { useEffect, useState } from 'preact/hooks';
import { copyText } from '../lib/adminKey';
import { restart } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, setupMode } from '../state/device';
import { toast } from '../state/toasts';
import { transport, transportActions } from '../state/transport';
import { Button } from './Button';
import { Card, CardFooter } from './Card';
import { ActionState, TransactButton } from './Transact';

export function TransportCard() {
  const writable = useWritable();
  const current = config.value;
  const setup = setupMode.value;
  const credential = transport.revealed.value;
  const lifecycle = useTransact();
  const fallback = useTransact();
  const recovery = useTransact();
  const [cleartextPort, setCleartextPort] = useState('39000');
  const [securePort, setSecurePort] = useState('39001');

  useEffect(() => {
    if (!current) return;
    setCleartextPort(String(current.transport.cleartext_port));
    setSecurePort(String(current.transport.secure_port));
  }, [current]);

  if (!current) return null;
  const status = current.transport;
  const actions = transportActions(status);
  const disabled = !writable || setup;
  const secure = status.mode === 'tls-psk';

  const copy = (value: string, label: string) => {
    copyText(value).then(
      () => toast(`${label} copied`, 'ok'),
      (error) => toast(error.message, 'err'),
    );
  };

  return (
    <Card
      gated
      title="PCM transport"
      lead={
        setup
          ? 'Finish first setup in cleartext, then provision an encrypted bridge connection.'
          : secure
            ? `Authenticated TLS 1.3 is active on port ${status.effective_port}. It never falls back automatically.`
            : `Cleartext is active on port ${status.effective_port}. Encryption is opt-in and independently verified before cutover.`
      }
    >
      <div class="formgrid">
        <div class="field">
          <label for="cleartext_port">Cleartext port</label>
          <input
            id="cleartext_port"
            type="number"
            min="1"
            max="65535"
            disabled={disabled}
            value={cleartextPort}
            onInput={(event) => setCleartextPort(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="secure_port">Encrypted port</label>
          <input
            id="secure_port"
            type="number"
            min="1"
            max="65535"
            disabled={disabled}
            value={securePort}
            onInput={(event) => setSecurePort(event.currentTarget.value)}
          />
        </div>
      </div>

      <div class="meta">
        <span>active key: {status.active_key_id || 'none'}</span>
        <span>pending key: {status.pending_key_id || 'none'}</span>
        <span>previous key: {status.rollback_key_id || 'none'}</span>
      </div>

      {credential && (
        <div class="keypanel">
          <p>
            <strong class="strong">Copy this bridge credential now.</strong> The PSK is shown only
            once and no read endpoint can return it.
          </p>
          <span class="streamlabel">Key ID</span>
          <div class="keyblock">{credential.key_id}</div>
          <Button disabled={!writable} onClick={() => copy(credential.key_id, 'Key ID')}>
            Copy key ID
          </Button>
          <span class="streamlabel">PSK</span>
          <div class="keyblock">{credential.psk}</div>
          <div class="inputrow inputrow-center">
            <Button disabled={!writable} onClick={() => copy(credential.psk, 'PSK')}>
              Copy PSK
            </Button>
            <Button onClick={() => transport.dismissReveal()}>Hide secret</Button>
          </div>
          {credential.recovery && (
            <p class="help">
              Cleartext is saved for the next boot. Copy the replacement credential, provision it on
              the bridge, then restart this device.
            </p>
          )}
        </div>
      )}

      <CardFooter>
        <TransactButton
          transact={lifecycle}
          disabled={disabled || !actions.canStage}
          onClick={() =>
            lifecycle.run(() => transport.stage(), { okText: 'Key generated — copy it now' })
          }
        >
          {status.active_key_id ? 'Stage rotation key' : 'Generate encrypted key'}
        </TransactButton>
        <TransactButton
          transact={lifecycle}
          disabled={disabled || !actions.canVerify}
          onClick={() =>
            lifecycle.run(() => transport.verify(), {
              busyText: 'Verifying with bridge…',
              okText: 'Bridge accepted the pending key',
            })
          }
        >
          Verify with bridge
        </TransactButton>
        <TransactButton
          transact={lifecycle}
          disabled={disabled || !actions.canActivate}
          onClick={() =>
            lifecycle.run(() => transport.activate(), {
              reboots: 'the encrypted PCM transport',
            })
          }
        >
          Activate encryption
        </TransactButton>
        {actions.canRollback && (
          <TransactButton
            transact={lifecycle}
            disabled={disabled}
            onClick={() =>
              lifecycle.run(() => transport.rollback(), { reboots: 'the previous PCM key' })
            }
          >
            Roll back key
          </TransactButton>
        )}
        {actions.canRetire && (
          <TransactButton
            transact={lifecycle}
            disabled={disabled}
            onClick={() => lifecycle.run(() => transport.retire())}
          >
            Retire previous key
          </TransactButton>
        )}
        <ActionState state={lifecycle.state} />
      </CardFooter>

      <div class="notice">
        <strong>Cleartext fallback.</strong> This is an explicit restart, never an automatic
        downgrade. Use recovery if the bridge credential is lost.
      </div>
      <CardFooter>
        <TransactButton
          transact={fallback}
          kind="danger"
          disabled={disabled || !secure}
          onClick={() =>
            fallback.run(
              () => transport.useCleartext(current, Number(cleartextPort), Number(securePort)),
              { reboots: 'cleartext PCM transport' },
            )
          }
        >
          Use cleartext &amp; restart
        </TransactButton>
        <TransactButton
          transact={recovery}
          disabled={disabled}
          onClick={() =>
            recovery.run(() => transport.recover(), {
              okText: 'Recovery saved — copy the new key, then restart',
            })
          }
        >
          Recover lost key
        </TransactButton>
        {credential?.recovery && (
          <TransactButton
            transact={recovery}
            kind="danger"
            disabled={disabled}
            onClick={() => recovery.run(() => restart(), { reboots: 'transport recovery' })}
          >
            Restart into cleartext
          </TransactButton>
        )}
        <ActionState state={fallback.state.text ? fallback.state : recovery.state} />
      </CardFooter>
    </Card>
  );
}
