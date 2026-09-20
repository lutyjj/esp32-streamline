import { useState } from 'preact/hooks';
import { restart } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, setupMode } from '../state/device';
import {
  setupWizardRequested,
  transport,
  transportActions,
  transportJourney,
} from '../state/transport';
import { Button } from './Button';
import { ConfirmButton } from './ConfirmButton';
import { CredentialReveal } from './CredentialReveal';
import { Disclosure } from './Disclosure';
import { Kv } from './Kv';
import { Section, SectionActions } from './Section';
import { SettingRow } from './SettingRow';
import { ActionState, TransactButton } from './Transact';

/**
 * The Encryption card on the Connections page. Setup — create, enroll, verify,
 * activate — runs in the guided TransportWizard; this card owns the steady
 * state and every exit: credential facts through `Kv`, rollback and
 * retirement, and Recovery nested under Advanced security.
 */
export function TransportCard({ targetDirty = false }: { targetDirty?: boolean }) {
  const writable = useWritable();
  const current = config.value;
  const credential = transport.revealed.value;
  const lifecycle = useTransact();
  const recovery = useTransact();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  if (!current || setupMode.value) return null;
  const status = current.transport;
  const actions = transportActions(status);
  const journey = transportJourney(status);
  const secure = status.mode === 'tls-psk';
  const setupUnderway = journey === 'provision' || journey === 'activate';

  const credentialRows: [string, string][] = [];
  if (status.active_key_id) credentialRows.push(['Active credential', status.active_key_id]);
  if (status.pending_key_id) credentialRows.push(['Pending credential', status.pending_key_id]);
  if (status.rollback_key_id) credentialRows.push(['Previous credential', status.rollback_key_id]);

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
      <SectionActions compact>
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
            message="The device stays on cleartext. Restore cleartext in the bridge Settings if you switched its mode, or audio will remain paused. Remove the unused bridge credential there."
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
      </SectionActions>
    </Disclosure>
  );

  return (
    <Section gated title="Encrypted audio" className="transport-card">
      <SettingRow
        title="Audio to your bridge"
        status={secure ? 'Active' : setupUnderway ? 'Setup in progress' : 'Off'}
        tone={secure ? 'good' : setupUnderway ? 'warn' : 'neutral'}
        description={
          secure
            ? 'The device uses TLS 1.3. Check the bridge for audio reception.'
            : setupUnderway
              ? 'This device still uses cleartext. If the bridge requires encryption, audio is paused until you activate here or restore cleartext there.'
              : 'Protect your audio with an authenticated connection. Setup coordinates this device and the bridge.'
        }
      >
        <Button
          disabled={!writable || targetDirty}
          onClick={() => {
            if (secure) {
              setAdvancedOpen(true);
              setRecoveryOpen(true);
            } else {
              setupWizardRequested.value = true;
            }
          }}
        >
          {secure ? 'Disable encryption' : setupUnderway ? 'Resume setup' : 'Set up encryption'}
        </Button>
      </SettingRow>
      {targetDirty && <span class="help">Save the stream target before changing encryption.</span>}

      {credential && !setupUnderway && (
        <CredentialReveal credential={credential} onDone={() => transport.dismissReveal()} />
      )}

      {setupUnderway && (
        <>
          {credential && (
            <CredentialReveal credential={credential} onDone={() => transport.dismissReveal()} />
          )}
          <div class="transport-keys">
            <Kv rows={credentialRows} />
          </div>
          {recoverySection}
        </>
      )}

      {(secure || journey === 'rotation') && (
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
          <SectionActions compact>
            {actions.canStage && (
              <Button
                disabled={!writable}
                onClick={() => {
                  setupWizardRequested.value = true;
                }}
              >
                Replace bridge credential
              </Button>
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
              <ConfirmButton
                label="Forget previous credential"
                confirmLabel="Forget it"
                disabled={!writable || lifecycle.busy}
                message="The previous credential is deleted from the device — switching back to it is no longer possible."
                onConfirm={() =>
                  lifecycle.run(() => transport.retire(), {
                    okText: 'Previous credential forgotten',
                  })
                }
              />
            )}
            <ActionState state={lifecycle.state} />
          </SectionActions>
          {recoverySection}
        </Disclosure>
      )}
    </Section>
  );
}
