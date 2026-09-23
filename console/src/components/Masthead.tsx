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
import { status, unreachable } from '../state/device';
import { toast } from '../state/toasts';
import { LockChip, type LockState } from './LockChip';
import { UnlockPanel } from './UnlockPanel';

export function Masthead({
  panelOpen,
  onPanelOpen: setPanelOpen,
}: {
  panelOpen: boolean;
  onPanelOpen: (open: boolean) => void;
}) {
  useAuthEpoch();
  const s = status.value;

  const chip: { state: LockState; text: string; sub: string } = !s
    ? { state: 'neutral', text: unreachable.value ? 'Unavailable' : 'Checking…', sub: '' }
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
    if (!s?.auth_required) return;
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
          <div class="console-identity">{s?.device_name || 'Device console'}</div>
          <span class="identity-detail">
            {unreachable.value
              ? 'Unavailable'
              : s
                ? `Firmware ${s.firmware_version}`
                : 'Connecting…'}
          </span>
        </div>
        <div class="masthead-actions">
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
  const [error, setError] = useState('');

  async function unlock() {
    setError('');
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
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UnlockPanel
      onClose={onDone}
      id="admin-unlock-panel"
      secret={secret}
      onSecret={setSecret}
      onUnlock={unlock}
      busy={busy}
      error={error}
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
