import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { Card, CardFooter } from '../components/Card';
import { Chip, type Tone } from '../components/Chip';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { LockChip, type LockState } from '../components/LockChip';
import { MeterRow } from '../components/Meter';
import { Notice } from '../components/Notice';
import { SectionHead } from '../components/SectionHead';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { Toasts } from '../components/Toasts';
import { Toggle } from '../components/Toggle';
import { UnlockPanel } from '../components/UnlockPanel';
import type { RecordingSnapshot, SourceSnapshot, TransportSnapshot } from '../generated/bridge';
import { dbfs } from '../lib/format';
import { toast } from '../state/toasts';
import { bridgeBase } from './http';
import { bridge } from './state';

/** Lifecycle and recording states share the console's status tones. */
function stateTone(state: string): Tone {
  switch (state) {
    case 'connected':
    case 'complete':
      return 'good';
    case 'recording':
      return 'bad';
    case 'waiting-for-audio':
    case 'interrupted':
      return 'warn';
    default:
      return 'neutral';
  }
}

function StateChip({ state }: { state: string }) {
  return (
    <Chip tone={stateTone(state)} dot>
      {state.replaceAll('-', ' ')}
    </Chip>
  );
}

export function BridgeApp() {
  const status = bridge.status.value;
  const access = bridge.access.value;
  const [panelOpen, setPanelOpen] = useState(false);

  const chip: { state: LockState; text: string; sub: string } =
    access === 'checking'
      ? { state: 'neutral', text: 'Checking…', sub: '' }
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
    <main class="wrap bridge-console">
      <header class="masthead">
        <div>
          <h1 class="wordmark">
            Stream<span>Line</span>
          </h1>
          <div class="devname">Bridge console</div>
          <div class="chips">
            <Chip tone={bridge.unreachable.value ? 'bad' : status ? 'good' : 'neutral'} dot>
              {status ? `v${status.bridge_version}` : 'Checking…'}
            </Chip>
          </div>
        </div>
        <div class="masthead-actions">
          <ThemeSwitch />
          <LockChip state={chip.state} text={chip.text} sub={chip.sub} onClick={onLockClick} />
        </div>
      </header>
      {access === 'locked' && panelOpen && <BridgeUnlock onDone={() => setPanelOpen(false)} />}
      {bridge.error.value && <Notice tone="error">{bridge.error.value}</Notice>}
      <section class="bridge-group">
        <SectionHead title="Sources" note="Live · updates every second" />
        <p class="grouplead">Devices streaming PCM to this bridge.</p>
        <div class="bridge-list">
          {status &&
          Object.entries(status.sources).filter(([ip]) => ip !== 'pending').length > 0 ? (
            Object.entries(status.sources)
              .filter(([ip]) => ip !== 'pending')
              .map(([ip, source]) => <SourceCard key={ip} ip={ip} source={source} />)
          ) : (
            <EmptyState>
              No source is connected. Point a StreamLine device at TCP port 39000.
            </EmptyState>
          )}
        </div>
      </section>
      <Transport />
      <Recordings />
      <Toasts />
    </main>
  );
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
      // The controller surfaces the reason in the page banner.
    } finally {
      setBusy(false);
    }
  }

  return (
    <UnlockPanel
      secret={token}
      onSecret={setToken}
      onUnlock={unlock}
      busy={busy}
      placeholder="bridge API token"
      autoComplete="current-password"
    />
  );
}

function Transport() {
  const status = bridge.status.value?.transport;
  const access = bridge.access.value;
  if (!status) return null;
  const secure = status.mode === 'tls-psk';
  return (
    <section class="bridge-group">
      <div class="section-head">
        <h2>Encryption</h2>
        <span class="eyebrow">
          {secure ? 'Encrypted · TLS 1.3' : 'Cleartext'} · PCM port {status.port}
        </span>
      </div>
      <p class="grouplead">
        {secure
          ? 'Only devices with an enrolled credential can stream. Cleartext connections are rejected.'
          : 'Any device on the network can stream to this port unencrypted.'}
      </p>
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
    <div class="cardstack">
      <Card
        title="Device credentials"
        lead={
          unlocked
            ? 'Add the one-time credential from the device console. Enroll it before switching to encrypted, so audio only pauses while the device follows.'
            : 'Select Locked in the header to unlock this bridge, then enroll device credentials and switch encryption.'
        }
      >
        {unlocked && <CredentialForm />}
        <div class="bridge-list transport-key-list">
          {status.key_ids.length ? (
            status.key_ids.map((id) => (
              <div class="transport-key" key={id}>
                <code>{id}</code>
                {unlocked && (
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Remove"
                    onConfirm={() => void bridge.removeTransportKey(id)}
                  />
                )}
              </div>
            ))
          ) : (
            <div class="empty">No device credential is enrolled.</div>
          )}
        </div>
        <div class="transport-mode">
          <Toggle
            checked={secure}
            disabled={!unlocked || busy}
            onChange={async (enabled) => {
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
            label="Encrypt incoming audio"
            description={
              secure
                ? 'Turning this off drops encrypted devices and accepts unencrypted audio again.'
                : 'Turning this on pauses audio from every device until it verifies and activates its credential.'
            }
          />
        </div>
      </Card>
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
      <CardFooter compact flush>
        <Button kind="primary" type="submit" busy={busy}>
          Enroll credential
        </Button>
      </CardFooter>
    </form>
  );
}

export function SourceCard({ ip, source }: { ip: string; source: SourceSnapshot }) {
  const listeners = `${source.clients} listener${source.clients === 1 ? '' : 's'}`;
  const streamUrl = new URL(`${bridgeBase()}/streamline.wav`, window.location.origin);
  streamUrl.searchParams.set('source', ip);
  return (
    <Card className="source-card">
      <div class="source-head">
        <h3>{ip}</h3>
        <StateChip state={source.lifecycle.state} />
      </div>
      <div class="meta">
        <span>{formatBytes(source.bytes)} received</span>
        <span>{listeners}</span>
        <span>{source.lost ? `${source.lost} lost` : 'clean'}</span>
        <span>up {formatDuration(source.uptime_seconds)}</span>
      </div>
      <div class="bridge-meter">
        <div class="meter-head">
          <span>Live level</span>
          <span>RMS · peak marker</span>
        </div>
        <MeterRow label="L" rms={source.levels.rms_left} peak={source.levels.peak_left} />
        <MeterRow label="R" rms={source.levels.rms_right} peak={source.levels.peak_right} />
        <div class="meterfoot">
          RMS {dbfs(source.levels.rms_left)} / {dbfs(source.levels.rms_right)} dBFS
        </div>
      </div>
      <div class="streamrow">
        <span class="streamlabel">Stream URL</span>
        <code class="stream">{streamUrl.toString()}</code>
      </div>
    </Card>
  );
}

function Recordings() {
  const access = bridge.access.value;
  const capabilities = bridge.capabilities.value;
  if (!capabilities) return null;
  return (
    <section class="bridge-group">
      <SectionHead
        title="Recordings"
        note={!capabilities.enabled ? 'off' : access === 'unlocked' ? 'unlocked' : 'locked'}
      />
      {!capabilities.enabled ? (
        <EmptyState>
          Recording is off. Turn on recordings in the bridge configuration, then restart the bridge.
        </EmptyState>
      ) : access !== 'unlocked' ? (
        <EmptyState>
          Recordings are locked. Select Locked in the header to unlock, then manage them.
        </EmptyState>
      ) : (
        <RecordingWorkspace />
      )}
    </section>
  );
}

function RecordingWorkspace() {
  const data = bridge.recordings.value;
  const sources = Object.keys(bridge.status.value?.sources || {}).filter(
    (source) => source !== 'pending',
  );
  const [source, setSource] = useState(sources[0] || '');
  const [title, setTitle] = useState('');
  const selectedSource = sources.includes(source) ? source : sources[0] || '';
  if (!data) return <EmptyState>Loading recordings…</EmptyState>;
  return (
    <div class="cardstack">
      <Card
        title="New recording"
        lead="Start first, then play the source. WAV uses about 11 MiB per minute."
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await bridge.startRecording({ source: selectedSource, title })) setTitle('');
          }}
        >
          <div class="formgrid">
            <div class="field">
              <label for="rec-source">Source</label>
              <select
                id="rec-source"
                value={selectedSource}
                onChange={(event) => setSource(event.currentTarget.value)}
                required
              >
                {sources.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="rec-title">Title</label>
              <input
                id="rec-title"
                type="text"
                value={title}
                maxlength={80}
                onInput={(event) => setTitle(event.currentTarget.value)}
                required
              />
            </div>
          </div>
          <CardFooter>
            <Button kind="primary" type="submit" disabled={!selectedSource}>
              Start recording
            </Button>
            <span class="actionstate">{formatBytes(data.storage.free_bytes)} free</span>
          </CardFooter>
        </form>
      </Card>
      <RecordingList title="Active" items={data.active} active />
      <RecordingList title="Saved" items={data.saved} />
    </div>
  );
}

function RecordingList({
  title,
  items,
  active = false,
}: {
  title: string;
  items: RecordingSnapshot[];
  active?: boolean;
}) {
  return (
    <Card title={title}>
      <div class="bridge-list">
        {items.length ? (
          items.map((item) => <RecordingCard key={item.id} item={item} active={active} />)
        ) : (
          <EmptyState>No {title.toLowerCase()} recordings.</EmptyState>
        )}
      </div>
    </Card>
  );
}

function RecordingCard({ item, active }: { item: RecordingSnapshot; active: boolean }) {
  return (
    <article class="recording">
      <div>
        <StateChip state={item.state} />
        <h3>{item.title}</h3>
        <div class="meta">
          <span>{item.source}</span>
          <span>{formatDuration(item.duration_seconds)}</span>
          <span>{formatBytes(item.bytes)}</span>
          <span>{item.gap_packets ? `${item.gap_packets} silent gaps` : 'No timeline gaps'}</span>
        </div>
      </div>
      <div class="actions">
        {active ? (
          <Button kind="danger" onClick={() => void bridge.stopRecording(item.id)}>
            Stop and save
          </Button>
        ) : (
          <>
            <Button
              onClick={async () => {
                const ticket = await bridge.downloadTicket(item.id);
                if (!ticket) return;
                const link = document.createElement('a');
                link.href = `${bridgeBase()}${ticket.url}`;
                link.download = item.file_name || `${item.title}.wav`;
                link.click();
              }}
            >
              Download WAV
            </Button>
            <ConfirmButton
              label="Delete"
              confirmLabel="Delete"
              onConfirm={() => void bridge.deleteRecording(item.id)}
            />
          </>
        )}
      </div>
    </article>
  );
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}
