import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { MeterRow } from '../components/Meter';
import { ThemeSwitch } from '../components/ThemeSwitch';
import type { RecordingSnapshot, SourceSnapshot } from '../generated/bridge';
import { dbfs } from '../lib/format';
import { bridgeBase } from './http';
import { bridge } from './state';

export function BridgeApp() {
  const status = bridge.status.value;
  return (
    <main class="wrap bridge-console">
      <header class="masthead">
        <div>
          <h1 class="wordmark">
            Stream<span>Line</span>
          </h1>
          <div class="devname">Bridge console</div>
          <div class="chips">
            <span class="chip">
              <span
                class={`statusdot ${bridge.unreachable.value ? 'bad' : status ? 'good' : ''}`}
              />
              {status ? `v${status.bridge_version}` : 'Checking…'}
            </span>
          </div>
        </div>
        <div class="masthead-actions">
          <ThemeSwitch />
          {bridge.recordingState.value === 'unlocked' && (
            <Button className="bridge-lock" onClick={() => bridge.lock()}>
              Lock recordings
            </Button>
          )}
        </div>
      </header>
      {bridge.error.value && <div class="notice error">{bridge.error.value}</div>}
      <section class="bridge-group">
        <div class="section-head">
          <h2>Sources</h2>
          <span class="eyebrow">Live · updates every second</span>
        </div>
        <p class="grouplead">Devices streaming PCM to this bridge.</p>
        <div class="bridge-list">
          {status &&
          Object.entries(status.sources).filter(([ip]) => ip !== 'pending').length > 0 ? (
            Object.entries(status.sources)
              .filter(([ip]) => ip !== 'pending')
              .map(([ip, source]) => <SourceCard key={ip} ip={ip} source={source} />)
          ) : (
            <div class="empty">
              No source is connected. Point a StreamLine device at TCP port 39000.
            </div>
          )}
        </div>
      </section>
      <Recordings />
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
        <span class={`pill ${source.lifecycle.state}`}>
          {source.lifecycle.state.replaceAll('-', ' ')}
        </span>
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
  const state = bridge.recordingState.value;
  if (state === 'checking') return null;
  return (
    <section class="bridge-group">
      <div class="section-head">
        <h2>Recordings</h2>
        <span class="eyebrow">{state}</span>
      </div>
      {state === 'disabled' && (
        <Card lead="Recording is off. Configure writable storage and a recording token, then restart the bridge.">
          {null}
        </Card>
      )}
      {state === 'locked' && <RecordingUnlock />}
      {state === 'unlocked' && <RecordingWorkspace />}
    </section>
  );
}

function RecordingUnlock() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card lead="Enter the recording token configured on this bridge. It stays in this browser tab.">
      <form
        class="unlockform"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await bridge.unlock(token);
          } catch {
            // The controller owns the visible error state.
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="password"
          autocomplete="current-password"
          placeholder="recording token"
          value={token}
          onInput={(event) => setToken(event.currentTarget.value)}
          required
        />
        <Button kind="primary" type="submit" busy={busy}>
          Unlock
        </Button>
      </form>
    </Card>
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
  if (!data) return <Card lead="Loading recordings…">{null}</Card>;
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
            <label class="field">
              <span>Source</span>
              <select
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
            </label>
            <label class="field">
              <span>Title</span>
              <input
                value={title}
                maxlength={80}
                onInput={(event) => setTitle(event.currentTarget.value)}
                required
              />
            </label>
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
          <div class="empty">No {title.toLowerCase()} recordings.</div>
        )}
      </div>
    </Card>
  );
}

function RecordingCard({ item, active }: { item: RecordingSnapshot; active: boolean }) {
  return (
    <article class="recording">
      <div>
        <span class={`pill ${item.state}`}>{item.state.replaceAll('-', ' ')}</span>
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
            <Button
              kind="danger"
              onClick={() => {
                if (window.confirm(`Delete "${item.title}"?`)) void bridge.deleteRecording(item.id);
              }}
            >
              Delete
            </Button>
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
