import { Button } from './Button';
import { RememberSwitch } from './RememberSwitch';

interface UnlockPanelProps {
  secret: string;
  onSecret: (value: string) => void;
  onUnlock: () => void;
  busy: boolean;
  placeholder: string;
  /** `off` for a fresh key, `current-password` where a manager may fill it. */
  autoComplete?: string;
  /** Present only where the secret may persist across sessions (the admin key). */
  remember?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Present only where a saved secret can be dropped. */
  forget?: { label: string; onForget: () => void };
}

/**
 * The inline unlock row shared by both consoles: a secret field that submits on
 * Enter, an optional remember toggle, the Unlock button, and an optional forget
 * action. The device (admin key) and bridge (recording token) supply their own
 * custody — the panel only lays it out.
 */
export function UnlockPanel({
  secret,
  onSecret,
  onUnlock,
  busy,
  placeholder,
  autoComplete = 'off',
  remember,
  forget,
}: UnlockPanelProps) {
  return (
    <div class="unlockpanel">
      <input
        type="password"
        autocomplete={autoComplete}
        placeholder={placeholder}
        value={secret}
        onInput={(event) => onSecret(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onUnlock();
        }}
      />
      {remember && <RememberSwitch checked={remember.checked} onChange={remember.onChange} />}
      <Button kind="primary" busy={busy} onClick={onUnlock}>
        Unlock
      </Button>
      {forget && <Button onClick={forget.onForget}>{forget.label}</Button>}
    </div>
  );
}
