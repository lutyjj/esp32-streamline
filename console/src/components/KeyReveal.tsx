import { copySecret } from '../lib/adminKey';
import { toast } from '../state/toasts';
import { RememberSwitch } from './RememberSwitch';

/**
 * One-time reveal of an admin key: the key block plus the remember switch
 * and copy action every reveal offers.
 */
export function KeyReveal({
  secret,
  remember,
  onRemember,
  disabled = false,
  copiedToast = 'Admin key copied',
}: {
  secret: string;
  remember: boolean;
  onRemember: (remember: boolean) => void;
  disabled?: boolean;
  copiedToast?: string;
}) {
  return (
    <>
      <div class="keyblock">{secret}</div>
      <div class="inputrow" style="align-items:center">
        <RememberSwitch checked={remember} onChange={onRemember} disabled={disabled} />
        <button
          class="btn secondary"
          type="button"
          disabled={disabled}
          onClick={() =>
            copySecret(secret).then(
              () => toast(copiedToast, 'ok'),
              (err) => toast(err.message, 'err'),
            )
          }
        >
          Copy key
        </button>
      </div>
    </>
  );
}
