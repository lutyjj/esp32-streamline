import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Chip, type Tone } from '../components/Chip';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { LockChip } from '../components/LockChip';
import { MeterRow } from '../components/Meter';
import { Notice } from '../components/Notice';
import { SectionHead } from '../components/SectionHead';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { Toasts } from '../components/Toasts';
import { UnlockPanel } from '../components/UnlockPanel';
import type { RecordingSnapshot, SourceSnapshot } from '../generated/bridge';
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
  const recordingState = bridge.recordingState.value;
  const [panelOpen, setPanelOpen] = useState(false);

  function onLockClick() {
    if (bridge.recordingState.value === 'unlocked') {
      bridge.lock();
      toast('Recordings locked', 'ok');
      setPanelOpen(false);
    } else {
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
          {(recordingState === 'locked' || recordingState === 'unlocked') && (
            <LockChip
              state={recordingState}
              text={recordingState === 'unlocked' ? 'Unlocked' : 'Locked'}
              sub={recordingState === 'unlocked' ? '· click to lock' : '· click to unlock'}
              onClick={onLockClick}
            />
          )}
        </div>
      </header>
      {recordingState === 'locked' && panelOpen && (
        <RecordingUnlock onDone={() => setPanelOpen(false)} />
      )}
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
      <Recordings />
      <Toasts />
    </main>
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

function RecordingUnlock({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    try {
      await bridge.unlock(token.trim());
      toast('Recordings unlocked', 'ok');
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
      placeholder="recording token"
      autoComplete="current-password"
    />
  );
}

function Recordings() {
  const state = bridge.recordingState.value;
  if (state === 'checking') return null;
  return (
    <section class="bridge-group">
      <SectionHead title="Recordings" note={state} />
      {state === 'disabled' && (
        <EmptyState>
          Recording is off. Configure writable storage and a recording token, then restart the
          bridge.
        </EmptyState>
      )}
      {state === 'locked' && (
        <EmptyState>Recordings are locked. Choose Unlock in the header to manage them.</EmptyState>
      )}
      {state === 'unlocked' && <RecordingWorkspace />}
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
      <div class="grid">
        <Card title="New recording" lead="Start first, then play the source.">
          <form
            class="formgrid"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await bridge.startRecording({ source: selectedSource, title })) setTitle('');
            }}
          >
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
            <Button kind="primary" type="submit" disabled={!selectedSource}>
              Start recording
            </Button>
          </form>
        </Card>
        <Card title="Storage" lead="WAV uses about 11 MiB per minute.">
          <div class="storage-value">{formatBytes(data.storage.free_bytes)} free</div>
        </Card>
      </div>
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
