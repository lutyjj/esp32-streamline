import { useState } from 'preact/hooks';
import { errorMessage } from '../lib/errors';
import { expectedHostname, handoffConfirmed, joinNetwork } from '../state/join';
import { setupKey } from '../state/setupKey';
import { Button } from './Button';
import { DialogSheet } from './DialogSheet';
import { KeyReveal } from './KeyReveal';

const ONBOARDING_STEPS = ['wifi', 'key', 'joining'] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** First-run onboarding: Wi-Fi · admin key · joining. */
export function OnboardingOverlay({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<OnboardingStep>('wifi');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function next() {
    setError('');
    if (step === 'wifi') {
      if (!ssid.trim()) {
        setError('Enter your Wi-Fi network name');
        return;
      }
      if (!password) {
        setError('Enter the Wi-Fi password');
        return;
      }
      setStep('key');
    } else if (step === 'key') {
      join();
    }
  }

  /** Explain the network handoff without claiming the station is reachable. */
  async function join() {
    setBusy(true);
    setError('');
    try {
      // No target: the bridge is configured later, from the home network.
      await joinNetwork({ ssid, password, rememberKey: remember });
    } catch (err) {
      setBusy(false);
      setError(`Not saved — ${errorMessage(err)}`);
      return;
    }
    setBusy(false);
    setStep('joining');
  }

  return (
    <DialogSheet
      label="First-run setup"
      steps={ONBOARDING_STEPS}
      currentStep={step}
      onDismiss={onClose}
      footer={
        <>
          <Button onClick={onClose}>{step === 'joining' ? 'Close' : 'Cancel'}</Button>
          {step === 'key' && (
            <Button disabled={busy} onClick={() => setStep('wifi')}>
              Back
            </Button>
          )}
          <div class="sheetfoot-row">
            <output class="actionstate err">{error}</output>
            {step !== 'joining' && (
              <Button kind="primary" busy={busy} onClick={next}>
                {step === 'wifi' ? 'Continue' : 'I saved my key, join network'}
              </Button>
            )}
          </div>
        </>
      }
    >
      {step === 'wifi' && (
        <div>
          <h3>Welcome — let’s put StreamLine on your network</h3>
          <div class="body">
            <p>
              You’re connected to the device’s own setup network. Pick your home Wi-Fi and
              StreamLine will join it and restart.
            </p>
          </div>
          <div class="formgrid formgrid-single">
            <div class="field">
              <label for="ob_ssid">Your Wi-Fi network</label>
              <input
                id="ob_ssid"
                type="text"
                autocomplete="off"
                value={ssid}
                onInput={(e) => setSsid(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for="ob_password">Wi-Fi password</label>
              <input
                id="ob_password"
                type="password"
                autocomplete="new-password"
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </div>
          </div>
        </div>
      )}

      {step === 'key' && (
        <div>
          <h3>Save your admin key</h3>
          <div class="body">
            <p>
              This key unlocks settings later. It is shown <strong class="strong">only once</strong>
              . Copy it somewhere safe now. Browser storage only remembers this address. You will
              need this key again at the device’s home-network address.
            </p>
          </div>
          <KeyReveal secret={setupKey.value} remember={remember} onRemember={setRemember} />
        </div>
      )}

      {step === 'joining' && <JoiningStep ssid={ssid.trim()} />}
    </DialogSheet>
  );
}

function JoiningStep({ ssid }: { ssid: string }) {
  const hostname = expectedHostname();

  return (
    <div>
      <h3>{handoffConfirmed.value ? `Joining ${ssid}…` : 'Check the network handoff'}</h3>
      {!handoffConfirmed.value && (
        <p class="wznote">
          The connection ended before the save could be confirmed. Keep your admin key. Try the
          home-network address, or return to setup and retry.
        </p>
      )}
      <div class="body">
        <p>
          The setup network may disappear while the device joins. Reconnect to your own Wi-Fi, then
          find your device at:
        </p>
      </div>
      <div class="bigread">
        <span class="n bigread-address">{`http://${hostname}/`}</span>
      </div>
      <div class="body">
        <p>
          Open that address to verify the connection. If it is unavailable, return to the setup
          network and retry.
        </p>
      </div>
      <div class="body body-spaced">
        <p>Two steps left once you’re back in the console:</p>
        <ol class="checklist">
          <li>
            <b>Point StreamLine at your bridge</b> — Connections page
          </li>
          <li>
            <b>Calibrate input levels</b> — Audio page; have a loud track ready
          </li>
        </ol>
      </div>
    </div>
  );
}
