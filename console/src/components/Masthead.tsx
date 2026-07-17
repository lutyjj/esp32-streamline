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
import { Chip } from './Chip';
import { LockChip, type LockState } from './LockChip';
import { ThemeSwitch } from './ThemeSwitch';
import { UnlockPanel } from './UnlockPanel';

export function Masthead() {
  useAuthEpoch();
  const s = status.value;
  const [panelOpen, setPanelOpen] = useState(false);

  const chip: { state: LockState; text: string; sub: string } = !s
    ? { state: 'neutral', text: 'Checking…', sub: '' }
    : !s.auth_required
      ? { state: 'unlocked', text: 'Setup mode', sub: '· no key yet' }
      : isUnlocked()
        ? {
            state: 'unlocked',
            text: 'Unlocked',
            sub: `· ${Math.max(1, Math.round((unlockUntil() - Date.now()) / 60000))} min left — click to lock`,
          }
        : {
            state: 'locked',
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
            <Chip tone={!s ? 'neutral' : unreachable.value ? 'bad' : 'good'} dot>
              v{s?.firmware_version ?? '—'}
            </Chip>
            <Chip>
              {s ? `${s.audio.sample_rate / 1000} kHz / ${s.audio.bits_per_sample}-bit` : '— Hz'}
            </Chip>
            <Chip>
              {s ? (setupMode.value ? s.wifi.ap_ip : s.wifi.hostname || s.wifi.sta_ip) : '—'}
            </Chip>
          </div>
        </div>
        <div class="masthead-actions">
          <ThemeSwitch />
          <LockChip
            state={chip.state}
            text={chip.text}
            sub={chip.sub}
            onClick={onChipClick}
            expanded={panelOpen && !isUnlocked()}
            controls="admin-unlock-panel"
          />
        </div>
      </header>
      {panelOpen && !isUnlocked() && <AdminUnlock onDone={() => setPanelOpen(false)} />}
    </>
  );
}

function AdminUnlock({ onDone }: { onDone: () => void }) {
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
      // The unlock succeeded against the device either way; degraded local
      // custody only changes how long this browser keeps the key.
      if (unlockSettings(key, remember)) {
        toast('Settings unlocked for 15 minutes', 'ok');
      } else {
        toast(
          'Unlocked for this tab only — browser storage is unavailable, so the key cannot be remembered',
          'err',
        );
      }
      onDone();
    } catch (error) {
      toast(errorMessage(error), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <UnlockPanel
      id="admin-unlock-panel"
      secret={secret}
      onSecret={setSecret}
      onUnlock={unlock}
      busy={busy}
      placeholder="admin key"
      remember={{ checked: remember, onChange: setRemember }}
      forget={
        storedAdminKey()
          ? {
              label: 'Forget saved key',
              onForget: () => {
                forgetAdminKey();
                setSecret('');
                toast('Saved admin key forgotten', 'ok');
              },
            }
          : undefined
      }
    />
  );
}
