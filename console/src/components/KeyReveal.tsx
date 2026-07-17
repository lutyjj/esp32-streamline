import { copyText } from '../lib/custody';
import { toast } from '../state/toasts';
import { Button } from './Button';
import { RememberSwitch } from './RememberSwitch';

/**
 * One-time reveal of an admin key: the key block plus the remember switch
 * and copy action every reveal offers.
 */
export function KeyReveal({
  secret,
  remember,
  onRemember,
  copiedToast = 'Admin key copied',
}: {
  secret: string;
  remember: boolean;
  onRemember: (remember: boolean) => void;
  copiedToast?: string;
}) {
  return (
    <>
      <div class="keyblock">{secret}</div>
      <div class="inputrow inputrow-center">
        <RememberSwitch checked={remember} onChange={onRemember} />
        <Button
          onClick={() =>
            copyText(secret).then(
              () => toast(copiedToast, 'ok'),
              (err) => toast(err.message, 'err'),
            )
          }
        >
          Copy key
        </Button>
      </div>
    </>
  );
}
