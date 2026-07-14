import { useState } from 'preact/hooks';
import { useTransact, useWritable } from '../lib/hooks';
import { config } from '../state/device';
import { rebootWait } from '../state/rebootWait';
import {
  type SetupWizardStep,
  setupWizardStep,
  transport,
  transportJourney,
} from '../state/transport';
import { Button } from './Button';
import { ConfirmButton } from './ConfirmButton';
import { CredentialReveal } from './CredentialReveal';
import { DialogSheet } from './DialogSheet';
import { ActionState, TransactButton } from './Transact';

const WIZARD_STEPS = ['credential', 'enroll', 'activate', 'done'] as const;

/**
 * The guided encryption setup: create the device's bridge credential, enroll
 * it on the bridge, verify, then activate — the same DialogSheet journey as
 * calibration and bridge setup. It resumes at whatever step the device's key
 * state is in, and only sequences the public transport endpoints; the Stream
 * target card stays the manual escape hatch for recovery and rotation.
 */
export function TransportWizard({ onClose }: { onClose: () => void }) {
  const writable = useWritable();
  const c = config.value;
  const [step, setStep] = useState<SetupWizardStep>(() =>
    c ? setupWizardStep(c.transport) : 'credential',
  );
  const lifecycle = useTransact();

  if (!c) return null;
  const credential = transport.revealed.value;
  const journey = transportJourney(c.transport);
  const waiting = rebootWait.value !== null;
  // The device saves tls-psk before it reboots, so config alone reads
  // encrypted early; setup is settled only once the reboot wait resolved too.
  const settled = c.transport.mode === 'tls-psk' && !waiting;

  function advance(next: SetupWizardStep) {
    lifecycle.setState({ text: '', cls: '' });
    setStep(next);
  }

  function stage() {
    lifecycle.run(
      async () => {
        await transport.stage();
        return undefined;
      },
      { okText: 'Credential created — copy it now' },
    );
  }

  function verify() {
    lifecycle.run(
      async () => {
        const ack = await transport.verify();
        advance('activate');
        return ack;
      },
      { busyText: 'Asking the bridge…', okText: 'The bridge accepted this credential' },
    );
  }

  function activate() {
    lifecycle.run(
      async () => {
        const ack = await transport.activate();
        setStep('done');
        return ack;
      },
      { reboots: 'encrypted streaming' },
    );
  }

  function discardAndClose() {
    lifecycle.run(
      async () => {
        const ack = await transport.discard();
        onClose();
        return ack;
      },
      { okText: 'Credential discarded' },
    );
  }

  const bridgeConsoleUrl = c.target_host ? `http://${c.target_host}:8088/` : '';

  return (
    <DialogSheet
      label="Encryption setup"
      steps={WIZARD_STEPS}
      currentStep={step}
      onDismiss={onClose}
      footer={
        <>
          <Button onClick={onClose}>{step === 'done' ? 'Close' : 'Continue later'}</Button>
          <div class="sheetfoot-row">
            {step === 'credential' &&
              (credential || (journey !== 'opt-in' && journey !== 'secure') ? (
                <Button kind="primary" onClick={() => advance('enroll')}>
                  Continue
                </Button>
              ) : (
                <TransactButton transact={lifecycle} disabled={!writable} onClick={stage}>
                  {journey === 'secure' ? 'Create replacement credential' : 'Create credential'}
                </TransactButton>
              ))}
            {step === 'enroll' && (
              <TransactButton transact={lifecycle} disabled={!writable} onClick={verify}>
                Verify with bridge
              </TransactButton>
            )}
            {step === 'activate' && (
              <TransactButton transact={lifecycle} disabled={!writable} onClick={activate}>
                Activate encryption
              </TransactButton>
            )}
            {step === 'done' && (
              <Button kind="primary" onClick={onClose}>
                Done
              </Button>
            )}
          </div>
        </>
      }
    >
      {step === 'credential' && (
        <div>
          <h3>Create this device’s bridge credential</h3>
          <div class="body">
            <p>
              The device and the bridge share one private credential, so the bridge knows exactly
              which device is streaming. Audio keeps playing while you set this up.
            </p>
            {!credential && journey !== 'opt-in' && journey !== 'secure' && (
              <p>
                A credential is already waiting from an earlier session. Its PSK was shown once — if
                you still have it, continue; if not, discard it under Recovery on the Stream target
                card and start over.
              </p>
            )}
          </div>
          {credential && <CredentialReveal credential={credential} writable={writable} />}
          {!credential && <ActionState state={lifecycle.state} />}
        </div>
      )}

      {step === 'enroll' && (
        <div>
          <h3>Add it to your bridge</h3>
          <div class="body">
            <ol class="checklist">
              <li>
                <b>Open the bridge console</b>
                {bridgeConsoleUrl ? (
                  <>
                    {' — usually '}
                    <a href={bridgeConsoleUrl} target="_blank" rel="noreferrer">
                      {bridgeConsoleUrl}
                    </a>
                    {' (Home Assistant users: the add-on’s Web UI).'}
                  </>
                ) : (
                  ' (Home Assistant users: the add-on’s Web UI).'
                )}
              </li>
              <li>
                <b>Unlock it</b> with the bridge API token from your bridge configuration.
              </li>
              <li>
                <b>Add the credential</b> — paste the ID and PSK under Device credentials.
              </li>
              <li>
                <b>Switch on “Encrypt incoming audio”.</b> Audio pauses until this device follows.
              </li>
            </ol>
            <p>Then come back and verify — the device makes a real test connection.</p>
          </div>
          {credential && <CredentialReveal credential={credential} writable={writable} />}
          <ActionState state={lifecycle.state} />
          <ConfirmButton
            label="Changed my mind — discard this credential"
            confirmLabel="Discard it"
            disabled={!writable}
            message="The staged credential is deleted and the device stays on cleartext. Remove the bridge copy in its console if you already added it."
            onConfirm={discardAndClose}
          />
        </div>
      )}

      {step === 'activate' && (
        <div>
          <h3>Turn encryption on</h3>
          <div class="body">
            <p>The bridge accepted this credential. One step left.</p>
            <p>
              Activating restarts the device into encrypted streaming — audio pauses for about ten
              seconds and comes back encrypted.
            </p>
          </div>
          <ActionState state={lifecycle.state} />
        </div>
      )}

      {step === 'done' && (
        <div>
          <h3>{settled ? 'Encrypted and streaming' : 'Restarting…'}</h3>
          <div class="body">
            {!settled ? (
              <p>The device is restarting into encrypted mode — about ten seconds.</p>
            ) : (
              <>
                <p>
                  Every packet to the bridge is now authenticated TLS 1.3. No routine action is
                  needed — credential replacement and recovery live under Advanced security on the
                  Stream target card.
                </p>
                <p>Play a track: the Bridge tile reads Sending and the bridge shows this device.</p>
              </>
            )}
          </div>
        </div>
      )}
    </DialogSheet>
  );
}
