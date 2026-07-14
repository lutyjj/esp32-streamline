import { useEffect, useState } from 'preact/hooks';
import { copyText } from '../lib/adminKey';
import { restart } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, setupMode } from '../state/device';
import { toast } from '../state/toasts';
import { optInRequested, transport, transportActions, transportJourney } from '../state/transport';
import { Button } from './Button';
import { CardFooter } from './Card';
import { Chip } from './Chip';
import { ConfirmButton } from './ConfirmButton';
import { Disclosure } from './Disclosure';
import { Kv } from './Kv';
import { Toggle } from './Toggle';
import { ActionState, TransactButton } from './Transact';

/**
 * The Encrypt transport section of the Stream target card. Sub-sections are
 * `Disclosure`s (Advanced security, with Recovery nested inside), credential
 * facts render through `Kv`, and every action row is a `CardFooter` — the
 * same building blocks as the rest of the console.
 */
export function TransportCard({ targetDirty = false }: { targetDirty?: boolean }) {
  const writable = useWritable();
  const current = config.value;
  const credential = transport.revealed.value;
  const lifecycle = useTransact();
  const recovery = useTransact();
  const [setupOpen, setSetupOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [pskReveal, setPskReveal] = useState<{ keyId?: string; visible: boolean }>({
    visible: false,
  });

  // The bridge wizard hands off here: open the opt-in and clear the request.
  const wantsOptIn = optInRequested.value;
  useEffect(() => {
    if (!wantsOptIn) return;
    optInRequested.value = false;
    setSetupOpen(true);
  }, [wantsOptIn]);

  if (!current || setupMode.value) return null;
  const status = current.transport;
  const actions = transportActions(status);
  const journey = transportJourney(status);
  const secure = status.mode === 'tls-psk';
  const steady = journey === 'secure' || journey === 'rotation';
  const expanded = journey !== 'opt-in' || setupOpen;
  const pskVisible = pskReveal.keyId === credential?.key_id && pskReveal.visible;

  const copy = (value: string, label: string) => {
    copyText(value).then(
      () => toast(`${label} copied`, 'ok'),
      (error) => toast(error.message, 'err'),
    );
  };

  const credentialRows: [string, string][] = [];
  if (status.active_key_id) credentialRows.push(['Active credential', status.active_key_id]);
  if (status.pending_key_id) credentialRows.push(['Pending credential', status.pending_key_id]);
  if (status.rollback_key_id) credentialRows.push(['Previous credential', status.rollback_key_id]);

  const lifecycleFooter = (
    <CardFooter compact>
      {actions.canStage && (
        <TransactButton
          transact={lifecycle}
          disabled={!writable}
          onClick={() =>
            lifecycle.run(() => transport.stage(), { okText: 'Key generated — copy it now' })
          }
        >
          {status.active_key_id ? 'Replace bridge credential' : 'Generate bridge credential'}
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
            lifecycle.run(() => transport.activate(), { reboots: 'the encrypted PCM transport' })
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
          kind="secondary"
          disabled={!writable}
          onClick={() => lifecycle.run(() => transport.retire())}
        >
          Forget previous credential
        </TransactButton>
      )}
      <ActionState state={lifecycle.state} />
    </CardFooter>
  );

  const recoverySection = (
    <Disclosure
      title="Recovery"
      className="transport-recovery"
      open={recoveryOpen}
      onToggle={setRecoveryOpen}
    >
      <p class="help">
        {secure
          ? 'If the bridge lost this device’s key, switch the bridge to cleartext first, then disable encryption here.'
          : 'Lost the one-time secret? Replace the pending key, or discard it to stay on cleartext.'}
      </p>
      <CardFooter compact flush>
        {secure && (
          <ConfirmButton
            label="Disable encryption & restart"
            confirmLabel="Disable & restart"
            disabled={!writable}
            message="The device restarts and streams unencrypted. Switch the bridge to cleartext first or audio stays paused."
            onConfirm={() =>
              recovery.run(() => transport.useCleartext(current), {
                reboots: 'cleartext PCM transport',
              })
            }
          />
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
        {actions.canDiscard && (
          <ConfirmButton
            label="Discard pending credential"
            confirmLabel="Discard it"
            disabled={!writable}
            message="The staged key is deleted and this device stays on cleartext. The bridge copy, if provisioned, can be removed from its console."
            onConfirm={() =>
              recovery.run(() => transport.discard(), { okText: 'Pending credential discarded' })
            }
          />
        )}
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
        <ActionState state={recovery.state} />
      </CardFooter>
    </Disclosure>
  );

  return (
    <section class="transport-section">
      <Toggle
        checked={expanded}
        disabled={!writable || targetDirty}
        onChange={(checked) => {
          if (checked) {
            setSetupOpen(true);
          } else if (journey === 'opt-in') {
            setSetupOpen(false);
          } else {
            // Leaving encryption is an explicit choice that lives under
            // Recovery; unchecking opens the path instead of acting.
            setAdvancedOpen(true);
            setRecoveryOpen(true);
          }
        }}
        label={
          <span class="transport-title">
            Encrypt transport
            {secure && (
              <Chip tone="good" dot>
                encrypted
              </Chip>
            )}
          </span>
        }
        description={
          secure
            ? `TLS 1.3 to ${current.target_host}:${current.target_port}. No routine action is needed.`
            : 'Use authenticated TLS 1.3 on this same host and port.'
        }
      />
      {targetDirty && <span class="help">Save the stream target before changing encryption.</span>}

      {expanded && (
        <>
          {journey !== 'secure' && journey !== 'rotation' && <JourneyStep journey={journey} />}

          {credential && (
            <div class="keypanel transport-credential">
              <p>
                <strong class="strong">Copy this bridge credential now.</strong> Add it in the
                bridge console, then switch the bridge to encrypted mode there. The PSK is shown
                only once.
              </p>
              <span class="streamlabel">Credential ID</span>
              <div class="keyblock">{credential.key_id}</div>
              <span class="streamlabel">PSK</span>
              <div class="keyblock">{pskVisible ? credential.psk : '•••• •••• •••• ••••'}</div>
              <p class="help">
                Secret. Anyone with this PSK can impersonate the device to this bridge.
              </p>
              <div class="inputrow inputrow-center">
                <Button
                  kind="primary"
                  disabled={!writable}
                  onClick={() => copy(credential.psk, 'PSK')}
                >
                  Copy PSK
                </Button>
                <Button disabled={!writable} onClick={() => copy(credential.key_id, 'Key ID')}>
                  Copy key ID
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

          {steady ? (
            <Disclosure
              title="Advanced security"
              className="transport-advanced"
              open={advancedOpen}
              onToggle={(open) => {
                setAdvancedOpen(open);
                if (!open) setRecoveryOpen(false);
              }}
            >
              <div class="transport-keys">
                <Kv rows={credentialRows} />
              </div>
              {lifecycleFooter}
              {recoverySection}
            </Disclosure>
          ) : (
            <>
              {credentialRows.length > 0 && (
                <div class="transport-keys">
                  <Kv rows={credentialRows} />
                </div>
              )}
              {lifecycleFooter}
              {journey !== 'opt-in' && recoverySection}
            </>
          )}
        </>
      )}
    </section>
  );
}

function JourneyStep({ journey }: { journey: 'opt-in' | 'provision' | 'activate' }) {
  const content = {
    'opt-in': [
      'Step 1 of 3 · Create a bridge credential',
      'The device shows the bridge credential once. Cleartext keeps streaming.',
    ],
    provision: [
      'Step 2 of 3 · Enroll on the bridge and verify',
      'In the bridge console: unlock, add this credential, switch on encrypted mode. Then verify here.',
    ],
    activate: [
      'Step 3 of 3 · Activate',
      'The bridge accepted the key. Activation restarts the device into encrypted mode.',
    ],
  }[journey];
  return (
    <div class="transport-step">
      <strong>{content[0]}</strong>
      <p>{content[1]}</p>
    </div>
  );
}
