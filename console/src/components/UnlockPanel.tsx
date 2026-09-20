import { Button } from './Button';
import { DialogSheet } from './DialogSheet';
import { RememberSwitch } from './RememberSwitch';

interface UnlockPanelProps {
  id?: string;
  onClose: () => void;
  secret: string;
  onSecret: (value: string) => void;
  onUnlock: () => void;
  busy: boolean;
  error?: string;
  placeholder: string;
  /** `off` for a fresh key, `current-password` where a manager may fill it. */
  autoComplete?: string;
  /** Present only where the secret may persist across sessions (the admin key). */
  remember?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Present only where a saved secret can be dropped. */
  forget?: { label: string; onForget: () => void };
}

/**
 * Shared credential dialog. Enter submits; the caller owns authentication and
 * secret custody. Failures remain beside the entered credential for retry.
 */
export function UnlockPanel({
  id,
  onClose,
  secret,
  onSecret,
  onUnlock,
  busy,
  error,
  placeholder,
  autoComplete = 'off',
  remember,
  forget,
}: UnlockPanelProps) {
  return (
    <DialogSheet
      label="Unlock changes"
      steps={['unlock']}
      currentStep="unlock"
      onDismiss={onClose}
      footer={
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <form
        class="unlockpanel"
        id={id}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onUnlock();
        }}
      >
        <h3>Access this console</h3>
        <p>Enter the {placeholder} to change settings. Viewing stays available without it.</p>
        <label class="field">
          {placeholder === 'admin key' ? 'Admin key' : 'Bridge API token'}
          <input
            type="password"
            aria-label={placeholder}
            autocomplete={autoComplete}
            placeholder={placeholder}
            value={secret}
            onInput={(event) => onSecret(event.currentTarget.value)}
          />
        </label>
        {remember && <RememberSwitch checked={remember.checked} onChange={remember.onChange} />}
        <Button kind="primary" type="submit" busy={busy}>
          Unlock
        </Button>
        {forget && <Button onClick={forget.onForget}>{forget.label}</Button>}
        {error && (
          <output class="actionstate err" role="alert">
            {error}
          </output>
        )}
      </form>
    </DialogSheet>
  );
}
