import { useEffect, useState } from 'preact/hooks';
import { errorMessage } from '../lib/errors';
import { expectedHostname, joinNetwork } from '../state/join';
import { setupKey } from '../state/setupKey';
import { Button } from './Button';
import { DialogSheet } from './DialogSheet';
import { KeyReveal } from './KeyReveal';

/** Seconds the device takes to restart onto the home network. */
export const ONBOARDING_REBOOT_SECS = 10;

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

  /** Advance to the joining screen only on the device's confirmation. */
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
              . Copy it somewhere safe now.
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
  const [elapsed, setElapsed] = useState(0);
  const hostname = expectedHostname();

  useEffect(() => {
    const tick = setInterval(() => {
      setElapsed((e) => {
        if (e + 1 >= ONBOARDING_REBOOT_SECS) clearInterval(tick);
        return e + 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const done = elapsed >= ONBOARDING_REBOOT_SECS;
  return (
    <div>
      <h3>Joining {ssid}…</h3>
      <div class="body">
        <p>
          The setup network will disappear — that’s normal. Reconnect to your own Wi-Fi, then find
          your device at:
        </p>
      </div>
      <div class="bigread">
        <span class="n bigread-address">{`http://${hostname}/`}</span>
      </div>
      <div class="progress">
        <i style={{ width: `${Math.min(100, (elapsed / ONBOARDING_REBOOT_SECS) * 100)}%` }} />
      </div>
      <div class="body">
        <p>
          {done
            ? 'Done — reconnect to your own Wi-Fi and open the address above.'
            : `Restarting — about ${ONBOARDING_REBOOT_SECS - elapsed} s…`}
        </p>
      </div>
      <div class="body body-spaced">
        <p>Two steps left once you’re back in the console:</p>
        <ol class="checklist">
          <li>
            <b>Point StreamLine at your bridge</b> — Network tab, takes a minute
          </li>
          <li>
            <b>Calibrate input levels</b> — Audio tab; have a loud track ready
          </li>
        </ol>
      </div>
    </div>
  );
}
