import { useEffect, useState } from 'preact/hooks';
import { unlockSettings } from '../lib/adminKey';
import { postForm } from '../lib/api';
import { status } from '../state/device';
import { beginRebootWait } from '../state/rebootWait';
import { setupKey } from '../state/setupKey';
import { KeyReveal } from './KeyReveal';

/** Seconds the device takes to restart onto the home network. */
export const ONBOARDING_REBOOT_SECS = 10;

/** First-run onboarding: Wi-Fi · admin key · joining. */
export function OnboardingOverlay({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function next() {
    setError('');
    if (step === 1) {
      if (!ssid.trim()) {
        setError('Enter your Wi-Fi network name');
        return;
      }
      if (!password) {
        setError('Enter the Wi-Fi password');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      join();
    }
  }

  /**
   * Save Wi-Fi credentials and the admin key. Only the device's confirmation
   * advances to the joining screen: the response is flushed before the
   * restart, so a failed request means nothing was saved and the error is
   * shown where the user can act on it.
   */
  async function join() {
    setBusy(true);
    setError('');
    try {
      // No target_host: the bridge is configured later, from the home network.
      await postForm('/api/settings/network', {
        ssid: ssid.trim(),
        password,
        target_port: String(status.value?.target?.target_port || 39000),
        admin_secret: setupKey.value,
      });
    } catch (err) {
      setBusy(false);
      setError(`Not saved — ${err instanceof Error ? err.message : err}`);
      return;
    }
    setBusy(false);
    unlockSettings(setupKey.value, remember);
    beginRebootWait('the network settings');
    setStep(3);
  }

  return (
    <div class="overlay">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="First-run setup">
        <div class="stepline">
          FIRST-RUN SETUP
          <span class="stepdots">
            {[1, 2, 3].map((i) => (
              <i key={i} class={i <= step ? 'on' : ''} />
            ))}
          </span>
        </div>

        {step === 1 && (
          <div>
            <h3>Welcome — let’s put StreamLine on your network</h3>
            <div class="body">
              <p>
                You’re connected to the device’s own setup network. Pick your home Wi-Fi and
                StreamLine will join it and restart.
              </p>
            </div>
            <div class="formgrid" style="grid-template-columns:1fr">
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

        {step === 2 && (
          <div>
            <h3>Save your admin key</h3>
            <div class="body">
              <p>
                This key unlocks settings later. It is shown{' '}
                <strong style="color:var(--text)">only once</strong> — copy it somewhere safe now.
              </p>
            </div>
            <KeyReveal secret={setupKey.value} remember={remember} onRemember={setRemember} />
          </div>
        )}

        {step === 3 && <JoiningStep ssid={ssid.trim()} />}

        <div class="sheetfoot">
          <button class="btn secondary" type="button" onClick={onClose}>
            {step === 3 ? 'Close' : 'Cancel'}
          </button>
          <div class="row" style="align-items:center">
            <span class="actionstate err">{error}</span>
            {step < 3 && (
              <button
                class={`btn primary${busy ? ' busy' : ''}`}
                type="button"
                disabled={busy}
                onClick={next}
              >
                <span class="spin" />
                {step === 1 ? 'Continue' : 'I saved my key — join network'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JoiningStep({ ssid }: { ssid: string }) {
  const [elapsed, setElapsed] = useState(0);
  const hostname = status.value?.wifi?.hostname || 'streamline-xxxx.local';

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
        <span class="n" style="font-size:17px">{`http://${hostname}/`}</span>
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
      <div class="body" style="margin-top:4px">
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
