import { useState } from 'preact/hooks';
import { setTarget } from '../lib/api';
import { consoleAddress } from '../lib/consoleAddress';
import { useTransact, useWritable } from '../lib/hooks';
import { normalizeTargetHost } from '../lib/target';
import { bridgeConnection, config } from '../state/device';
import { rebootWait } from '../state/rebootWait';
import { setupWizardRequested } from '../state/transport';
import { FlowDialog, type FlowStep } from './FlowDialog';
import { ActionState } from './Transact';

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

type WizardStep = 'bridge' | 'connect' | 'encrypt';

/** Live narration of the link, reusing the same signal as the Bridge tile. */
function connectLine(): { text: string; cls: '' | 'ok' } {
  if (rebootWait.value) return { text: 'Saving and restarting — about 10 seconds.', cls: '' };
  switch (bridgeConnection.value) {
    case 'sending':
      return {
        text: 'The device is sending audio. Check reception in the bridge console.',
        cls: 'ok',
      };
    case 'connecting':
      return { text: 'Audio detected — reaching the bridge…', cls: '' };
    case 'idle':
      return { text: 'Target saved. Play a track to check transmission.', cls: '' };
    default:
      return { text: 'Waiting for the device…', cls: '' };
  }
}

/**
 * Bridge hookup wizard: choose where the bridge runs, point the device at it,
 * then optionally continue into the guided encryption setup. It only
 * sequences existing endpoints; the plain form on Settings → Connect a player stays as
 * the escape hatch.
 */
export function BridgeWizard({ onClose }: { onClose: () => void }) {
  const writable = useWritable();
  const c = config.value;
  const [step, setStep] = useState<WizardStep>('bridge');
  const [choice, setChoice] = useState<BridgeChoice>(BRIDGE_CHOICES[0]);
  const [host, setHost] = useState(c?.target_host ?? '');
  const [port, setPort] = useState(String(c?.target_port || BRIDGE_PORT));
  const [saved, setSaved] = useState(false);
  const [consoleUrl, setConsoleUrl] = useState('');
  const handoffUrl = consoleAddress(consoleUrl);
  const connect = useTransact();

  const secure = c?.transport.mode === 'tls-psk';
  const hasBridge = Boolean(c?.target_host);
  const dirty = c ? host.trim() !== c.target_host || Number(port) !== c.target_port : true;
  const needsSave = !saved && (dirty || !hasBridge);

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

  /** Continue straight into the guided encryption setup sheet. */
  function encrypt() {
    setupWizardRequested.value = true;
    onClose();
  }

  const live = connectLine();
  const back = (to: WizardStep) => [{ label: 'Back', onClick: () => setStep(to) }];

  const steps: FlowStep[] = [
    {
      id: 'bridge',
      body: (
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
          <a
            href="https://github.com/lutyjj/esp32-streamline#2-run-the-bridge"
            target="_blank"
            rel="noreferrer"
          >
            Open bridge installation guide
          </a>
        </div>
      ),
      primary: { label: 'Continue', onClick: () => setStep('connect') },
    },
    {
      id: 'connect',
      body: (
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
      ),
      secondary: back('bridge'),
      primary: needsSave
        ? {
            label: 'Save & connect',
            transact: connect,
            disabled: !writable || !host.trim() || !port,
            onClick: save,
          }
        : { label: 'Continue', onClick: () => setStep('encrypt') },
    },
    {
      id: 'encrypt',
      body: (
        <div>
          <h3>Connect your player</h3>
          <p>
            Open the bridge, check that this audio is arriving, then copy its stream address into
            your player.
          </p>
          <label class="field">
            Bridge console address
            <input
              type="url"
              value={consoleUrl}
              placeholder="http://bridge.local:8088"
              onInput={(event) => setConsoleUrl(event.currentTarget.value)}
            />
          </label>
          <p class="help">
            Use the address you open for the bridge, including its HTTP port. In Home Assistant,
            copy the bridge’s Open web UI address.
          </p>
          {consoleUrl && !handoffUrl && (
            <p class="err">
              Enter a complete HTTP or HTTPS address without a username or password.
            </p>
          )}
          {handoffUrl && (
            <a class="btn primary" href={handoffUrl} target="_blank" rel="noreferrer">
              Open bridge to listen
            </a>
          )}
          <p class="help">
            {secure
              ? 'Audio to the bridge is encrypted.'
              : 'To protect audio between this device and the bridge, set up encryption here or in Settings → Encrypted audio. Have the bridge API token ready.'}
          </p>
        </div>
      ),
      secondary: [
        ...back('connect'),
        ...(!secure ? [{ label: 'Set up encryption', disabled: !writable, onClick: encrypt }] : []),
      ],
      primary: { label: 'Done', onClick: onClose },
    },
  ];

  return (
    <FlowDialog
      label="Bridge setup"
      steps={steps}
      current={step}
      onDismiss={onClose}
      dismissLabel={step === 'encrypt' ? 'Close' : 'Cancel'}
    />
  );
}
