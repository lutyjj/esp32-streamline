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
import { CardFooter } from './Card';
import { Chip } from './Chip';
import { ConfirmButton } from './ConfirmButton';
import { CredentialReveal } from './CredentialReveal';
import { Disclosure } from './Disclosure';
import { Kv } from './Kv';
import { Toggle } from './Toggle';
import { ActionState, TransactButton } from './Transact';

/**
 * The Encrypt transport section of the Stream target card. Setup — create,
 * enroll, verify, activate — runs in the guided TransportWizard; this card
 * owns the steady state and every exit: credential facts through `Kv`,
 * rollback and retirement, and Recovery nested under Advanced security.
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
            message="The staged key is deleted and this device stays on cleartext. The bridge copy, if enrolled, can be removed from its console."
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
        checked={secure || setupUnderway}
        disabled={!writable || targetDirty}
        onChange={(checked) => {
          if (checked) {
            // Setup is guided; the toggle is its entry point.
            setupWizardRequested.value = true;
          } else if (setupUnderway) {
            // Backing out mid-setup is the discard edge under Recovery.
            setRecoveryOpen(true);
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
            {setupUnderway && (
              <Chip tone="warn" dot>
                setting up
              </Chip>
            )}
          </span>
        }
        description={
          secure
            ? `TLS 1.3 to ${current.target_host}:${current.target_port}. No routine action is needed.`
            : setupUnderway
              ? 'Setup is underway — a credential is staged but not active. Cleartext keeps streaming.'
              : 'Use authenticated TLS 1.3 on this same host and port. A guide walks you through it.'
        }
      />
      {targetDirty && <span class="help">Save the stream target before changing encryption.</span>}

      {credential && !setupUnderway && (
        <CredentialReveal
          credential={credential}
          writable={writable}
          onDone={() => transport.dismissReveal()}
        />
      )}

      {setupUnderway && (
        <>
          {credential && (
            <CredentialReveal
              credential={credential}
              writable={writable}
              onDone={() => transport.dismissReveal()}
            />
          )}
          <div class="transport-keys">
            <Kv rows={credentialRows} />
          </div>
          <CardFooter compact>
            <Button
              kind="primary"
              disabled={!writable}
              onClick={() => {
                setupWizardRequested.value = true;
              }}
            >
              Resume guided setup
            </Button>
          </CardFooter>
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
          <CardFooter compact>
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
          {recoverySection}
        </Disclosure>
      )}
    </section>
  );
}
