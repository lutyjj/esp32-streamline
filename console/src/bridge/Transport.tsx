import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { ConfirmButton } from '../components/ConfirmButton';
import { DestructiveAction } from '../components/DestructiveAction';
import { EmptyState } from '../components/EmptyState';
import { Section, SectionActions } from '../components/Section';
import { SettingRow } from '../components/SettingRow';
import type { TransportSnapshot } from '../generated/bridge';
import { toast } from '../state/toasts';
import { bridge } from './state';
export function Transport() {
  const status = bridge.status.value?.transport;
  const access = bridge.access.value;
  if (!status) return null;
  return (
    <section class="bridge-group">
      {!status.configurable ? (
        <EmptyState>
          Encryption control is off. Run the bridge with a transport state file
          (--transport-state-file), then restart it.
        </EmptyState>
      ) : access === 'no-token' ? (
        <EmptyState>
          Set api_token in the bridge configuration (or STREAMLINE_API_TOKEN), then restart the
          bridge to manage encryption here.
        </EmptyState>
      ) : (
        <TransportWorkspace status={status} unlocked={access === 'unlocked'} />
      )}
    </section>
  );
}

function TransportWorkspace({
  status,
  unlocked,
}: {
  status: TransportSnapshot;
  unlocked: boolean;
}) {
  const secure = status.mode === 'tls-psk';
  const [busy, setBusy] = useState(false);
  return (
    <div class="section-stack">
      <Section title="Encryption" gated>
        <div class="transport-mode">
          <SettingRow
            title="Incoming audio"
            status={secure ? 'Encrypted · TLS 1.3' : 'Cleartext'}
            tone={secure ? 'good' : 'neutral'}
            description={`TCP port ${status.port}. This mode applies to every device connected to this bridge.`}
          >
            <ConfirmButton
              label={secure ? 'Use cleartext' : 'Require encryption'}
              confirmLabel={
                secure ? 'Switch every device to cleartext' : 'Require encryption for every device'
              }
              message={
                secure
                  ? 'All encrypted connections will close. Set each device to cleartext to resume its audio.'
                  : 'All cleartext connections will close. Every device must have an enrolled credential, verify it, and activate encryption to resume audio.'
              }
              disabled={!unlocked || busy}
              onConfirm={async () => {
                const enabled = !secure;
                setBusy(true);
                try {
                  if (await bridge.setEncryption(enabled)) {
                    toast(
                      enabled
                        ? 'Encrypted mode on — devices must verify and activate'
                        : 'Cleartext mode on',
                      'ok',
                    );
                  }
                } finally {
                  setBusy(false);
                }
              }}
            />
          </SettingRow>
        </div>
      </Section>
      <Section
        gated
        title="Device credentials"
        lead={
          unlocked
            ? 'Enroll the one-time credential from each device before requiring encryption.'
            : 'Unlock to enroll a device’s credential or change the bridge mode.'
        }
      >
        {unlocked && <CredentialForm />}
        <div class="bridge-list transport-key-list">
          {status.key_ids.length ? (
            status.key_ids.map((id) => (
              <div class="transport-key" key={id}>
                <code>{id}</code>
                {unlocked && (
                  <DestructiveAction
                    label="Remove"
                    title={`Remove credential ${id}?`}
                    message="This closes the device's live audio connections. It cannot reconnect with this credential. Enroll a replacement to restore encrypted audio."
                    run={async () =>
                      (await bridge.removeTransportKey(id))
                        ? undefined
                        : bridge.error.value || 'Removal failed. Try again.'
                    }
                  />
                )}
              </div>
            ))
          ) : (
            <div class="empty">No device credential is enrolled.</div>
          )}
        </div>
      </Section>
    </div>
  );
}

function CredentialForm() {
  const [keyId, setKeyId] = useState('');
  const [psk, setPsk] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="formgrid"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          if (await bridge.provisionTransportKey(keyId.trim(), psk.trim())) {
            setKeyId('');
            setPsk('');
            toast('Credential enrolled', 'ok');
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      <div class="field">
        <label for="transport-key-id">Credential ID</label>
        <input
          id="transport-key-id"
          type="text"
          class="credential-input"
          value={keyId}
          pattern="eli1-[0-9a-f]{32}"
          autocomplete="off"
          onInput={(event) => setKeyId(event.currentTarget.value)}
          required
        />
      </div>
      <div class="field">
        <label for="transport-psk">PSK</label>
        <input
          id="transport-psk"
          class="credential-input"
          type="password"
          value={psk}
          pattern="[0-9a-f]{64}"
          autocomplete="new-password"
          onInput={(event) => setPsk(event.currentTarget.value)}
          required
        />
      </div>
      <SectionActions compact>
        <Button kind="primary" type="submit" busy={busy}>
          Enroll credential
        </Button>
      </SectionActions>
    </form>
  );
}
