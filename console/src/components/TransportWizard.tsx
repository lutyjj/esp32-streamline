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
import { ConfirmButton } from './ConfirmButton';
import { CredentialReveal } from './CredentialReveal';
import { FlowDialog, type FlowStep } from './FlowDialog';
import { ActionState } from './Transact';

/**
 * The guided encryption setup: create the device's bridge credential, enroll
 * it on the bridge, verify, then activate — the same guided flow as input
 * setup and bridge setup. It resumes at whatever step the device's key state
 * is in, and only sequences the public transport endpoints; the Encryption
 * card stays the manual escape hatch for recovery and rotation.
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

  const steps: FlowStep[] = [
    {
      id: 'credential',
      body: (
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
                you still have it, continue; if not, discard it under Recovery on the Encryption
                card and start over.
              </p>
            )}
          </div>
          {credential && <CredentialReveal credential={credential} writable={writable} />}
          {!credential && <ActionState state={lifecycle.state} />}
        </div>
      ),
      primary:
        credential || (journey !== 'opt-in' && journey !== 'secure')
          ? { label: 'Continue', onClick: () => advance('enroll') }
          : {
              label: journey === 'secure' ? 'Create replacement credential' : 'Create credential',
              transact: lifecycle,
              disabled: !writable,
              onClick: stage,
            },
    },
    {
      id: 'enroll',
      body: (
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
          <div class="wizard-abandon">
            <ConfirmButton
              label="Changed my mind — discard this credential"
              confirmLabel="Discard it"
              disabled={!writable}
              message="The staged credential is deleted and the device stays on cleartext. Remove the bridge copy in its console if you already added it."
              onConfirm={discardAndClose}
            />
          </div>
        </div>
      ),
      primary: {
        label: 'Verify with bridge',
        transact: lifecycle,
        disabled: !writable,
        onClick: verify,
      },
    },
    {
      id: 'activate',
      body: (
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
      ),
      primary: {
        label: 'Activate encryption',
        transact: lifecycle,
        disabled: !writable,
        onClick: activate,
      },
    },
    {
      id: 'done',
      body: (
        <div>
          <h3>{settled ? 'Encrypted and streaming' : 'Restarting…'}</h3>
          <div class="body">
            {!settled ? (
              <p class="wizard-waiting">
                <span class="spin" aria-hidden="true" />
                The device is restarting into encrypted mode — about ten seconds. This screen
                updates when it reconnects, and a notification confirms it.
              </p>
            ) : (
              <>
                <p>
                  Every packet to the bridge is now authenticated TLS 1.3. No routine action is
                  needed — credential replacement and recovery live under Advanced security in the
                  Network tab.
                </p>
                <p>Play a track: the Bridge tile reads Sending and the bridge shows this device.</p>
              </>
            )}
          </div>
        </div>
      ),
      primary: { label: 'Done', onClick: onClose },
    },
  ];

  return (
    <FlowDialog
      label="Encryption setup"
      steps={steps}
      current={step}
      onDismiss={onClose}
      dismissLabel={step === 'done' ? 'Close' : 'Continue later'}
    />
  );
}
