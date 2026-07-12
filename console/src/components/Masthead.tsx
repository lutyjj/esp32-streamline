import { useState } from 'preact/hooks';
import {
  forgetAdminKey,
  isUnlocked,
  keyRemembered,
  lockSettings,
  storedAdminKey,
  unlockSettings,
  unlockUntil,
  useAuthEpoch,
} from '../lib/adminKey';
import { verifyAdminKey } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { setupMode, status, unreachable } from '../state/device';
import { toast } from '../state/toasts';
import { Button } from './Button';
import { RememberSwitch } from './RememberSwitch';

export function Masthead() {
  useAuthEpoch();
  const s = status.value;
  const [panelOpen, setPanelOpen] = useState(false);

  const chip = !s
    ? { cls: '', text: 'Checking…', sub: '' }
    : !s.auth_required
      ? { cls: 'unlocked', text: 'Setup mode', sub: '· no key yet' }
      : isUnlocked()
        ? {
            cls: 'unlocked',
            text: 'Unlocked',
            sub: `· ${Math.max(1, Math.round((unlockUntil() - Date.now()) / 60000))} min left — click to lock`,
          }
        : {
            cls: 'locked',
            text: 'Locked',
            sub: storedAdminKey() ? '· key saved — click to unlock' : '· click to unlock',
          };

  function onChipClick() {
    if (!s || !s.auth_required) return;
    if (isUnlocked()) {
      lockSettings();
      toast('Settings locked', 'ok');
    } else {
      setPanelOpen(!panelOpen);
    }
  }

  return (
    <>
      <header class="masthead">
        <div>
          <h1 class="wordmark">
            Stream<span>Line</span>
          </h1>
          {s?.device_name && <div class="devname">{s.device_name}</div>}
          <div class="chips">
            <span class="chip">
              <span class={`statusdot ${!s ? '' : unreachable.value ? 'bad' : 'good'}`} />v
              {s?.firmware_version ?? '—'}
            </span>
            <span class="chip">
              {s ? `${s.audio.sample_rate / 1000} kHz / ${s.audio.bits_per_sample}-bit` : '— Hz'}
            </span>
            <span class="chip">
              {s ? (setupMode.value ? s.wifi.ap_ip : s.wifi.hostname || s.wifi.sta_ip) : '—'}
            </span>
          </div>
        </div>
        <button class={`lockchip ${chip.cls}`} type="button" onClick={onChipClick}>
          <span class="dot" />
          <span>{chip.text}</span>
          <small>{chip.sub}</small>
        </button>
      </header>
      {panelOpen && !isUnlocked() && <UnlockPanel onDone={() => setPanelOpen(false)} />}
    </>
  );
}

function UnlockPanel({ onDone }: { onDone: () => void }) {
  // A saved key pre-fills the field (masked) so it is visible that Unlock has
  // something to work with; replacing the text uses a different key.
  const [secret, setSecret] = useState(storedAdminKey());
  const [remember, setRemember] = useState(keyRemembered());
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    try {
      const typed = secret.trim();
      const key = typed || storedAdminKey();
      if (!key) throw new Error('enter the admin key');
      if (!(await verifyAdminKey(key))) {
        if (!typed || typed === storedAdminKey()) {
          forgetAdminKey();
          throw new Error('saved admin key was rejected and forgotten — enter the current key');
        }
        throw new Error('admin key rejected');
      }
      unlockSettings(key, remember);
      toast('Settings unlocked for 15 minutes', 'ok');
      onDone();
    } catch (error) {
      toast(errorMessage(error), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="unlockpanel">
      <input
        type="password"
        autocomplete="off"
        placeholder="admin key"
        value={secret}
        onInput={(e) => setSecret(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') unlock();
        }}
      />
      <RememberSwitch checked={remember} onChange={setRemember} />
      <Button kind="primary" busy={busy} onClick={unlock}>
        Unlock
      </Button>
      {Boolean(storedAdminKey()) && (
        <Button
          onClick={() => {
            forgetAdminKey();
            setSecret('');
            toast('Saved admin key forgotten', 'ok');
          }}
        >
          Forget saved key
        </Button>
      )}
    </div>
  );
}
