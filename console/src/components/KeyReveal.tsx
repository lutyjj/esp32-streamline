import { CopyButton } from './CopyButton';
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
        <CopyButton value={secret} copied={copiedToast}>
          Copy key
        </CopyButton>
      </div>
    </>
  );
}
