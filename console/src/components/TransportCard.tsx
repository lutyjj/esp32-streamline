import { useState } from 'preact/hooks';
import { copyText } from '../lib/adminKey';
import { restart } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, setupMode } from '../state/device';
import { toast } from '../state/toasts';
import { transport, transportActions, transportJourney } from '../state/transport';
import { Button } from './Button';
import { CardFooter } from './Card';
import { ActionState, TransactButton } from './Transact';

export function TransportCard({ targetDirty = false }: { targetDirty?: boolean }) {
  const writable = useWritable();
  const current = config.value;
  const credential = transport.revealed.value;
  const lifecycle = useTransact();
  const fallback = useTransact();
  const recovery = useTransact();
  const [setupOpen, setSetupOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [pskReveal, setPskReveal] = useState<{ keyId?: string; visible: boolean }>({
    visible: false,
  });

  if (!current || setupMode.value) return null;
  const status = current.transport;
  const actions = transportActions(status);
  const journey = transportJourney(status);
  const secure = status.mode === 'tls-psk';
  const expanded = journey !== 'opt-in' || setupOpen;
  const steady = journey === 'secure' || journey === 'rotation';
  const pskVisible = pskReveal.keyId === credential?.key_id && pskReveal.visible;

  const copy = (value: string, label: string) => {
    copyText(value).then(
      () => toast(`${label} copied`, 'ok'),
      (error) => toast(error.message, 'err'),
    );
  };

  return (
    <section class="transport-section">
      <label class="transport-choice">
        <input
          type="checkbox"
          checked={expanded}
          disabled={!writable || targetDirty}
          onInput={(event) => {
            if (event.currentTarget.checked) {
              setSetupOpen(true);
            } else if (journey === 'opt-in') {
              setSetupOpen(false);
            } else {
              setAdvancedOpen(true);
              setRecoveryOpen(true);
            }
          }}
        />
        <span>
          <strong>Encrypt transport</strong>
          <small>
            {secure
              ? `TLS 1.3 is active on ${current.target_host}:${current.target_port}.`
              : 'Use authenticated TLS 1.3 on this same host and port.'}
          </small>
        </span>
      </label>
      {targetDirty && <span class="help">Save the stream target before changing encryption.</span>}

      {expanded && (
        <>
          <JourneyStep journey={journey} />

          {(!steady || advancedOpen) &&
            (status.active_key_id || status.pending_key_id || status.rollback_key_id) && (
              <div class="meta transport-meta">
                {status.active_key_id && (
                  <span>
                    Active credential <code>{status.active_key_id}</code>
                  </span>
                )}
                {status.pending_key_id && (
                  <span>
                    Pending credential <code>{status.pending_key_id}</code>
                  </span>
                )}
                {status.rollback_key_id && (
                  <span>
                    Previous credential <code>{status.rollback_key_id}</code>
                  </span>
                )}
              </div>
            )}

          {credential && (
            <div class="keypanel transport-credential">
              <p>
                <strong class="strong">Copy this bridge credential now.</strong> Switch the bridge
                to TLS on this port, then add the credential in its console. The PSK is shown only
                once.
              </p>
              <span class="streamlabel">Credential ID</span>
              <div class="keyblock">{credential.key_id}</div>
              <Button disabled={!writable} onClick={() => copy(credential.key_id, 'Key ID')}>
                Copy key ID
              </Button>
              <span class="streamlabel">PSK</span>
              <div class="keyblock">{pskVisible ? credential.psk : '•••• •••• •••• ••••'}</div>
              <p class="help">
                Secret. Anyone with this PSK can impersonate the device to this bridge.
              </p>
              <div class="inputrow inputrow-center">
                <Button disabled={!writable} onClick={() => copy(credential.psk, 'PSK')}>
                  Copy PSK
                </Button>
                <Button
                  onClick={() => setPskReveal({ keyId: credential.key_id, visible: !pskVisible })}
                >
                  {pskVisible ? 'Hide PSK' : 'Reveal PSK'}
                </Button>
                <Button onClick={() => transport.dismissReveal()}>Done — I copied it</Button>
              </div>
              {credential.recovery && (
                <p class="help">
                  Recovery is saved. Provision this replacement on the bridge, then restart into
                  cleartext before verifying and activating it.
                </p>
              )}
            </div>
          )}

          {(!steady || advancedOpen) && (
            <CardFooter compact>
              {actions.canStage && (
                <TransactButton
                  transact={lifecycle}
                  disabled={!writable}
                  onClick={() =>
                    lifecycle.run(() => transport.stage(), {
                      okText: 'Key generated — copy it now',
                    })
                  }
                >
                  {status.active_key_id
                    ? 'Replace bridge credential'
                    : 'Generate bridge credential'}
                </TransactButton>
              )}
              {actions.canVerify && (
                <TransactButton
                  transact={lifecycle}
                  disabled={!writable}
                  onClick={() =>
                    lifecycle.run(() => transport.verify(), {
                      busyText: 'Verifying with bridge…',
                      okText: 'Bridge accepted the pending key',
                    })
                  }
                >
                  Verify with bridge
                </TransactButton>
              )}
              {actions.canActivate && (
                <TransactButton
                  transact={lifecycle}
                  disabled={!writable}
                  onClick={() =>
                    lifecycle.run(() => transport.activate(), {
                      reboots: 'the encrypted PCM transport',
                    })
                  }
                >
                  Activate encryption
                </TransactButton>
              )}
              {actions.canRollback && (
                <TransactButton
                  transact={lifecycle}
                  kind="secondary"
                  disabled={!writable}
                  onClick={() =>
                    lifecycle.run(() => transport.rollback(), { reboots: 'the previous PCM key' })
                  }
                >
                  Use previous credential
                </TransactButton>
              )}
              {actions.canRetire && (
                <TransactButton
                  transact={lifecycle}
                  disabled={!writable}
                  onClick={() => lifecycle.run(() => transport.retire())}
                >
                  Forget previous credential
                </TransactButton>
              )}
              <ActionState state={lifecycle.state} />
            </CardFooter>
          )}

          {steady && (
            <div class="transport-secondary">
              <Button
                onClick={() =>
                  setAdvancedOpen((open) => {
                    if (open) setRecoveryOpen(false);
                    return !open;
                  })
                }
              >
                {advancedOpen ? 'Hide advanced security' : 'Advanced security'}
              </Button>
            </div>
          )}

          {journey !== 'opt-in' && (!steady || advancedOpen) && (
            <div class="transport-secondary">
              <Button onClick={() => setRecoveryOpen((open) => !open)}>
                {recoveryOpen ? 'Hide recovery options' : 'Recovery options'}
              </Button>
            </div>
          )}

          {recoveryOpen && (
            <div class="notice transport-fallback">
              <strong>{secure ? 'Connection recovery.' : 'Lost the generated credential?'}</strong>
              <p>
                {secure
                  ? 'Switch the bridge to cleartext first. Then disable encryption here and restart the device.'
                  : 'Replace the pending key and copy its new one-time credential. Cleartext remains active.'}
              </p>
              <div class="actions">
                {secure && (
                  <TransactButton
                    transact={fallback}
                    kind="danger"
                    disabled={!writable}
                    onClick={() =>
                      fallback.run(() => transport.useCleartext(current), {
                        reboots: 'cleartext PCM transport',
                      })
                    }
                  >
                    Disable encryption &amp; restart
                  </TransactButton>
                )}
                <TransactButton
                  transact={recovery}
                  kind="secondary"
                  disabled={!writable}
                  onClick={() =>
                    recovery.run(() => transport.recover(), {
                      okText: 'Replacement generated — copy it now',
                    })
                  }
                >
                  {secure ? 'Replace lost credential' : 'Replace generated credential'}
                </TransactButton>
                {credential?.recovery && (
                  <TransactButton
                    transact={recovery}
                    kind="danger"
                    disabled={!writable}
                    onClick={() => recovery.run(() => restart(), { reboots: 'transport recovery' })}
                  >
                    Restart into cleartext
                  </TransactButton>
                )}
              </div>
              <ActionState state={fallback.state.text ? fallback.state : recovery.state} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function JourneyStep({ journey }: { journey: ReturnType<typeof transportJourney> }) {
  const content = {
    'opt-in': [
      'Step 1 of 3 · Create a bridge credential',
      'The device shows the bridge credential once. Cleartext keeps streaming.',
    ],
    provision: [
      'Step 2 of 3 · Switch the bridge and verify',
      'Switch this bridge port to TLS-only, provision the credential, then verify it here.',
    ],
    activate: [
      'Step 3 of 3 · Activate',
      'The bridge accepted the key. Activation restarts the device into encrypted mode.',
    ],
    secure: [
      'Encryption is on',
      'No routine action is required. Replace the bridge credential only if it may be exposed.',
    ],
    rotation: [
      'Encryption is on',
      'A previous credential is retained after replacement. No immediate action is required.',
    ],
  }[journey];
  return (
    <div class="transport-step">
      <strong>{content[0]}</strong>
      <p>{content[1]}</p>
    </div>
  );
}
