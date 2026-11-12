import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { EmptyState } from '../components/EmptyState';
import { Section } from '../components/Section';
import { SettingRow } from '../components/SettingRow';
import type {
  SendspinPairingToken,
  SendspinSnapshot,
  SendspinSourceSnapshot,
} from '../generated/bridge';
import { sendspinSourceView } from './sendspin';
import { bridge } from './state';

export function MusicAssistant() {
  const sendspin = bridge.status.value?.sendspin;
  const access = bridge.access.value;
  if (!sendspin) return null;
  return (
    <section class="bridge-group">
      {!sendspin.enabled ? (
        <EmptyState>
          Music Assistant publishing is off. Set sendspin_server_url in the bridge configuration (or
          --sendspin-server-url), then restart the bridge to offer every source as a Live Input.
        </EmptyState>
      ) : (
        <Publishing sendspin={sendspin} unlocked={access === 'unlocked'} />
      )}
    </section>
  );
}

function Publishing({ sendspin, unlocked }: { sendspin: SendspinSnapshot; unlocked: boolean }) {
  const token = bridge.pairingToken.value;
  return (
    <Section
      gated
      title="Music Assistant"
      lead={`Every source is offered to the Sendspin server at ${sendspin.server_url}.${unlocked ? '' : ' Unlock to pair a source.'}`}
    >
      {token && (
        <PairingTokenReveal
          token={token}
          name={
            sendspin.sources.find(({ source }) => source === token.source)?.name ?? token.source
          }
        />
      )}
      <div class="bridge-list">
        {sendspin.sources.length ? (
          sendspin.sources.map((source) => (
            <PublishedSource key={source.source} source={source} unlocked={unlocked} />
          ))
        ) : (
          <div class="empty">A source appears here once its device connects to this bridge.</div>
        )}
      </div>
    </Section>
  );
}

function PublishedSource({
  source,
  unlocked,
}: {
  source: SendspinSourceSnapshot;
  unlocked: boolean;
}) {
  const view = sendspinSourceView(source);
  const [busy, setBusy] = useState(false);
  return (
    <SettingRow title={source.name} status={view.label} tone={view.tone} description={view.detail}>
      {unlocked && (
        <Button
          kind={view.needsPairing ? 'primary' : undefined}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await bridge.createPairingToken(source.source);
            } finally {
              setBusy(false);
            }
          }}
        >
          {source.paired ? 'New pairing token' : 'Create pairing token'}
        </Button>
      )}
    </SettingRow>
  );
}

function PairingTokenReveal({ token, name }: { token: SendspinPairingToken; name: string }) {
  return (
    <div class="keypanel">
      <p>
        <strong class="strong">Paste this token into Music Assistant now.</strong> Open the setup of
        “{name}” in Music Assistant and enter it when asked for a pairing token. Creating another
        token replaces this one.
      </p>
      <div class="keyblock">{token.token}</div>
      <p class="help">Secret. Anyone with this token can pair the source to a Sendspin server.</p>
      <div class="keypanel-actions">
        <CopyButton value={token.token} copied="Pairing token copied">
          Copy pairing token
        </CopyButton>
        <Button onClick={() => bridge.dismissPairingToken()}>Done — I pasted it</Button>
      </div>
    </div>
  );
}
