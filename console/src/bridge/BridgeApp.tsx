import { useEffect, useState } from 'preact/hooks';
import { PageHeading } from '../components/ConsoleNavigation';
import { ConsoleShell } from '../components/ConsoleShell';
import { EmptyState } from '../components/EmptyState';
import { LockChip, type LockState } from '../components/LockChip';
import { Notice } from '../components/Notice';
import { SettingsWorkspace } from '../components/SettingsWorkspace';
import { Toasts } from '../components/Toasts';
import { UnlockPanel } from '../components/UnlockPanel';
import { toast } from '../state/toasts';
import { Recordings } from './Recordings';
import { IncomingSource } from './Sources';
import { bridge } from './state';
import { Transport } from './Transport';

export function BridgeApp() {
  const [view, setView] = useState(() => bridgeView());
  useEffect(() => {
    const change = () => setView(bridgeView());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const status = bridge.status.value;
  const access = bridge.access.value;
  const [panelOpen, setPanelOpen] = useState(false);

  const chip: { state: LockState; text: string; sub: string } =
    access === 'checking'
      ? { state: 'neutral', text: bridge.unreachable.value ? 'Unavailable' : 'Checking…', sub: '' }
      : access === 'no-token'
        ? { state: 'neutral', text: 'No API token', sub: '· set api_token to manage' }
        : access === 'unlocked'
          ? { state: 'unlocked', text: 'Unlocked', sub: '· click to lock' }
          : { state: 'locked', text: 'Locked', sub: '· click to unlock' };

  function onLockClick() {
    if (access === 'unlocked') {
      bridge.lock();
      toast('Bridge locked', 'ok');
      setPanelOpen(false);
    } else if (access === 'locked') {
      setPanelOpen((open) => !open);
    }
  }

  return (
    <ConsoleShell
      items={BRIDGE_NAVIGATION}
      current={view}
      locked={access !== 'unlocked'}
      onUnlock={
        access === 'locked'
          ? () => {
              setPanelOpen(true);
              window.scrollTo({ top: 0 });
            }
          : undefined
      }
      header={
        <header class="masthead">
          <div>
            <div class="console-identity">Bridge console</div>
            <span class="identity-detail">
              {bridge.unreachable.value
                ? 'Unavailable'
                : status
                  ? `Version ${status.bridge_version}`
                  : 'Connecting…'}
            </span>
          </div>
          <div class="masthead-actions">
            <LockChip
              state={chip.state}
              text={chip.text}
              sub={chip.sub}
              onClick={onLockClick}
              expanded={access === 'locked' && panelOpen}
              controls="bridge-unlock-panel"
            />
          </div>
        </header>
      }
    >
      {access === 'locked' && panelOpen && <BridgeUnlock onDone={() => setPanelOpen(false)} />}
      {bridge.error.value && !(panelOpen && access === 'locked') && (
        <Notice tone="error">{bridge.error.value}</Notice>
      )}
      <div>
        <section class="view active" hidden={view !== 'sources'}>
          <PageHeading label={BRIDGE_NAVIGATION[0].label} />
          <section class="bridge-group">
            {bridge.unreachable.value && (
              <Notice tone="warn">
                Bridge unavailable. Sources below are last-known information, not live readings.
              </Notice>
            )}
            <div class="bridge-list">
              {status &&
              Object.entries(status.sources).filter(([ip]) => ip !== 'pending').length > 0 ? (
                Object.entries(status.sources)
                  .filter(([ip]) => ip !== 'pending')
                  .map(([ip, source]) => <IncomingSource key={ip} ip={ip} source={source} />)
              ) : (
                <EmptyState>
                  {status && status.transport.mode === 'tls-psk' && status.transport.key_ids.length
                    ? `No audio right now. ${status.transport.key_ids.length === 1 ? 'The enrolled device appears' : `${status.transport.key_ids.length} enrolled devices appear`} here while their audio plays.`
                    : `Connect your device to this bridge on TCP port ${status?.transport.port ?? 39000}, then play audio. Its source and playback URL will appear here.`}
                </EmptyState>
              )}
            </div>
          </section>
        </section>
        <section class="view active" hidden={view !== 'settings'}>
          <PageHeading {...BRIDGE_NAVIGATION[2]} />
          <SettingsWorkspace
            label="Bridge settings"
            sections={[
              {
                id: 'security',
                label: 'Audio security',
                content: <Transport />,
              },
              {
                id: 'service',
                label: 'Service & access',
                content: (
                  <div class="service-details">
                    <h3>Console access</h3>
                    <p>
                      {access === 'no-token'
                        ? 'Set api_token in the bridge configuration, then restart to enable changes from this console.'
                        : 'Use your bridge API token to unlock changes. The device admin key is a separate credential.'}
                    </p>
                    <h3>Bridge service</h3>
                    <p>
                      Version {status?.bridge_version ?? 'unavailable'}. The audio listener uses TCP
                      port {status?.transport.port ?? 'unavailable'}.
                    </p>
                    <p>
                      Recording storage and listener settings are configured where the bridge is
                      deployed.
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </section>
        <section class="view active" hidden={view !== 'recordings'}>
          <PageHeading {...BRIDGE_NAVIGATION[1]} />
          <Recordings />
        </section>
      </div>
      <Toasts />
    </ConsoleShell>
  );
}

const BRIDGE_NAVIGATION = [
  {
    view: 'sources',
    label: 'Listen',
    description: 'Connect your player to incoming audio.',
  },
  {
    view: 'recordings',
    label: 'Recordings',
    description: 'Capture a source, stop when you are finished, and keep the WAV.',
  },
  {
    view: 'settings',
    label: 'Settings',
    description: 'Manage access and encryption for every device using this bridge.',
  },
] as const;

function bridgeView() {
  const candidate = window.location.hash.replace(/^#\//, '');
  return BRIDGE_NAVIGATION.find(({ view }) => view === candidate)?.view ?? 'sources';
}

function BridgeUnlock({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    try {
      await bridge.unlock(token);
      toast('Bridge unlocked', 'ok');
      onDone();
    } catch {
      // The shared unlock panel renders the controller's rejection.
    } finally {
      setBusy(false);
    }
  }

  return (
    <UnlockPanel
      onClose={onDone}
      id="bridge-unlock-panel"
      secret={token}
      onSecret={setToken}
      onUnlock={unlock}
      busy={busy}
      error={bridge.error.value}
      placeholder="bridge API token"
      autoComplete="current-password"
    />
  );
}
