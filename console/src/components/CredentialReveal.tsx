import { useState } from 'preact/hooks';
import { copyText } from '../lib/custody';
import { toast } from '../state/toasts';
import type { RevealedTransportKey } from '../state/transport';
import { Button } from './Button';

/**
 * The one-time bridge credential panel shared by the Encryption card and the
 * guided setup wizard: ID and PSK blocks, copy actions, and a masked
 * PSK that reveals only on request. The PSK is gone once dismissed.
 */
export function CredentialReveal({
  credential,
  onDone,
}: {
  credential: RevealedTransportKey;
  /** Present where dismissing the reveal is the owner's own step. */
  onDone?: () => void;
}) {
  const [pskVisible, setPskVisible] = useState(false);

  const copy = (value: string, label: string) => {
    copyText(value).then(
      () => toast(`${label} copied`, 'ok'),
      (error) => toast(error.message, 'err'),
    );
  };

  return (
    <div class="keypanel transport-credential">
      <p>
        <strong class="strong">Copy both values now</strong> — the bridge asks for the credential ID
        and the PSK together. The PSK is shown only once.
      </p>
      <span class="streamlabel">Credential ID</span>
      <div class="keyblock">{credential.key_id}</div>
      <span class="streamlabel">PSK</span>
      <div class="keyblock">{pskVisible ? credential.psk : '•••• •••• •••• ••••'}</div>
      <p class="help">Secret. Anyone with this PSK can impersonate the device to this bridge.</p>
      <div class="keypanel-actions">
        <Button kind="primary" onClick={() => copy(credential.key_id, 'Credential ID')}>
          Copy credential ID
        </Button>
        <Button kind="primary" onClick={() => copy(credential.psk, 'PSK')}>
          Copy PSK
        </Button>
        <Button onClick={() => setPskVisible((visible) => !visible)}>
          {pskVisible ? 'Hide PSK' : 'Reveal PSK'}
        </Button>
        {onDone && <Button onClick={onDone}>Done — I copied it</Button>}
      </div>
      {credential.recovery && (
        <p class="help">
          Recovery is saved. Enroll this replacement on the bridge, then restart into cleartext
          before verifying and activating it.
        </p>
      )}
    </div>
  );
}
