import { useState } from 'preact/hooks';
import { setTarget } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { normalizeTargetHost } from '../lib/target';
import { bridgeConnection, config } from '../state/device';
import { navigateTo } from '../state/navigation';
import { rebootWait } from '../state/rebootWait';
import { optInRequested } from '../state/transport';
import { Button } from './Button';
import { DialogSheet } from './DialogSheet';
import { ActionState, TransactButton } from './Transact';

/** Default PCM port the bridge and its Home Assistant add-on both publish. */
const BRIDGE_PORT = 39000;

interface BridgeChoice {
  id: string;
  label: string;
  setup: string;
  hint: string;
}

/** Where the bridge runs decides its install step and its address. */
const BRIDGE_CHOICES: BridgeChoice[] = [
  {
    id: 'ha-addon',
    label: 'Home Assistant add-on',
    setup:
      'In Home Assistant, open Settings → Add-ons, install ESP32 StreamLine Bridge, and start it.',
    hint: 'Use your Home Assistant address, for example homeassistant.local.',
  },
  {
    id: 'docker',
    label: 'Docker on my own server',
    setup: 'Run the bridge container on your server. The compose file is in the setup guide.',
    hint: 'Use the address of the server running the container.',
  },
  {
    id: 'existing',
    label: 'I already run a bridge',
    setup: 'Point this device at the bridge you already run.',
    hint: 'Use your bridge’s address.',
  },
];

const WIZARD_STEPS = ['bridge', 'connect', 'encrypt'] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** Live narration of the link, reusing the same signal as the Bridge tile. */
function connectLine(): { text: string; cls: '' | 'ok' } {
  if (rebootWait.value) return { text: 'Saving and restarting — about 10 seconds.', cls: '' };
  switch (bridgeConnection.value) {
    case 'sending':
      return { text: 'Audio is reaching the bridge. The Bridge tile reads Sending.', cls: 'ok' };
    case 'connecting':
      return { text: 'Audio detected — reaching the bridge…', cls: '' };
    case 'idle':
      return { text: 'Connected. Play a track on your source to start streaming.', cls: '' };
    default:
      return { text: 'Waiting for the device…', cls: '' };
  }
}

/**
 * Bridge hookup wizard: choose where the bridge runs, point the device at it,
 * then optionally hand the encryption opt-in to the Stream target card. It only
 * sequences existing endpoints; the plain form on the Network tab stays as the
 * escape hatch.
 */
export function BridgeWizard({ onClose }: { onClose: () => void }) {
  const writable = useWritable();
  const c = config.value;
  const [step, setStep] = useState<WizardStep>('bridge');
  const [choice, setChoice] = useState<BridgeChoice>(BRIDGE_CHOICES[0]);
  const [host, setHost] = useState(c?.target_host ?? '');
  const [port, setPort] = useState(String(c?.target_port || BRIDGE_PORT));
  const [saved, setSaved] = useState(false);
  const connect = useTransact();

  const secure = c?.transport.mode === 'tls-psk';
  const hasBridge = Boolean(c?.target_host);
  const dirty = c ? host.trim() !== c.target_host || Number(port) !== c.target_port : true;
  const needsSave = !saved && (dirty || !hasBridge);
  const stepIndex = WIZARD_STEPS.indexOf(step);

  function save() {
    connect.run(
      async () => {
        const data = await setTarget({
          target_host: normalizeTargetHost(host),
          target_port: Number(port),
        });
        setSaved(true);
        return data;
      },
      { busyText: 'Saving…', reboots: 'the stream target' },
    );
  }

  /** Hand the encryption opt-in to the Stream target card and leave. */
  function encrypt() {
    optInRequested.value = true;
    navigateTo('network');
    onClose();
  }

  const live = connectLine();

  return (
    <DialogSheet
      label="Bridge setup"
      steps={WIZARD_STEPS}
      currentStep={step}
      onDismiss={onClose}
      footer={
        <>
          <Button onClick={onClose}>{step === 'encrypt' ? 'Skip' : 'Cancel'}</Button>
          <div class="sheetfoot-row">
            {stepIndex > 0 && (
              <Button onClick={() => setStep(WIZARD_STEPS[stepIndex - 1])}>Back</Button>
            )}
            {step === 'bridge' && (
              <Button kind="primary" onClick={() => setStep('connect')}>
                Continue
              </Button>
            )}
            {step === 'connect' &&
              (needsSave ? (
                <TransactButton
                  transact={connect}
                  disabled={!writable || !host.trim() || !port}
                  onClick={save}
                >
                  Save &amp; connect
                </TransactButton>
              ) : (
                <Button kind="primary" onClick={() => setStep('encrypt')}>
                  Continue
                </Button>
              ))}
            {step === 'encrypt' &&
              (secure ? (
                <Button kind="primary" onClick={onClose}>
                  Done
                </Button>
              ) : (
                <Button kind="primary" disabled={!writable} onClick={encrypt}>
                  Set up encryption
                </Button>
              ))}
          </div>
        </>
      }
    >
      {step === 'bridge' && (
        <div>
          <h3>Where does your bridge run?</h3>
          <div class="body">
            <p>
              The bridge turns StreamLine’s audio into a stream your players can read. Pick how you
              run it.
            </p>
          </div>
          <div class="choicelist">
            {BRIDGE_CHOICES.map((option) => (
              <label key={option.id} class="choice">
                <input
                  type="radio"
                  name="bridge-choice"
                  checked={choice.id === option.id}
                  onInput={() => setChoice(option)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p class="wizhint">{choice.setup}</p>
        </div>
      )}

      {step === 'connect' && (
        <div>
          <h3>Point StreamLine at your bridge</h3>
          <div class="body">
            <p>{choice.hint}</p>
          </div>
          <div class="formgrid">
            <div class="field">
              <label for="wiz_host">Host or IP</label>
              <input
                id="wiz_host"
                type="text"
                autocomplete="off"
                disabled={!writable}
                value={host}
                onInput={(e) => {
                  setHost(e.currentTarget.value);
                  setSaved(false);
                }}
              />
            </div>
            <div class="field">
              <label for="wiz_port">Port</label>
              <input
                id="wiz_port"
                type="number"
                min="1"
                max="65535"
                disabled={!writable}
                value={port}
                onInput={(e) => {
                  setPort(e.currentTarget.value);
                  setSaved(false);
                }}
              />
            </div>
          </div>
          {needsSave ? (
            <ActionState state={connect.state} />
          ) : (
            <p class={`wizhint ${live.cls}`}>{live.text}</p>
          )}
        </div>
      )}

      {step === 'encrypt' && (
        <div>
          <h3>{secure ? 'Encryption is on' : 'Encrypt the connection?'}</h3>
          <div class="body">
            {secure ? (
              <p>This device already streams over authenticated TLS 1.3. Nothing else to do.</p>
            ) : (
              <>
                <p>
                  Streaming works now over plain TCP, which is fine on a home network you trust.
                </p>
                <p>
                  You can also wrap it in TLS 1.3 so each device authenticates with its own key.
                  Turning it on switches both sides together and pauses audio for a few seconds. It
                  stays available any time.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </DialogSheet>
  );
}
