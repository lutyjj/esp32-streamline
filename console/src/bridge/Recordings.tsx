import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { LoadFailure } from '../components/ResourceNotice';
import { Section, SectionActions } from '../components/Section';
import { SectionHead } from '../components/SectionHead';
import type { RecordingSnapshot } from '../generated/bridge';
import { formatBytes, formatDuration } from './format';
import { bridgeBase } from './http';
import { StateChip } from './StateChip';
import { bridge } from './state';
export function Recordings() {
  const access = bridge.access.value;
  const capabilities = bridge.capabilities.value;
  if (!capabilities) {
    if (!bridge.capabilitiesError.value) return null;
    return (
      <section class="bridge-group">
        <SectionHead title="Recordings" note="unavailable" />
        <LoadFailure
          name="recording capabilities"
          error={bridge.capabilitiesError.value}
          onRetry={() => void bridge.loadCapabilities()}
        />
      </section>
    );
  }
  return (
    <section class="bridge-group">
      {!capabilities.enabled ? (
        <EmptyState>
          Recording is off. Turn on recordings in the bridge configuration, then restart the bridge.
        </EmptyState>
      ) : access === 'no-token' ? (
        <EmptyState>
          Set api_token in the bridge configuration, then restart the bridge to manage recordings.
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
  const capabilities = bridge.capabilities.value;
  const sources = Object.keys(bridge.status.value?.sources || {}).filter(
    (source) => source !== 'pending',
  );
  const [source, setSource] = useState(sources[0] || '');
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);
  const [composing, setComposing] = useState(false);
  const selectedSource = sources.includes(source) ? source : sources[0] || '';
  if (!data) {
    if (!bridge.recordingsError.value) return <EmptyState>Loading recordings…</EmptyState>;
    return (
      <LoadFailure
        name="recordings"
        error={bridge.recordingsError.value}
        onRetry={() => void bridge.refreshRecordings()}
      />
    );
  }
  // The capability contract sizes the estimate and the limits; nothing here
  // hardcodes what the bridge already declares.
  const perMinute = capabilities ? formatBytes(capabilities.format.bytes_per_second * 60) : '';
  const composer = (
    <Section
      title="New recording"
      lead={`${sources.length ? 'Choose a known source. Start recording, then play it.' : 'Play audio on your device once so the bridge can discover it. Then pause, select the source here, and start recording before playing again.'}${perMinute ? ` WAV uses about ${perMinute} per minute.` : ''}`}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setStarting(true);
          try {
            const outcome = await bridge.startRecording({ source: selectedSource, title });
            if (outcome === 'done' || outcome === 'refresh-failed') {
              setTitle('');
              setComposing(false);
            }
          } finally {
            setStarting(false);
          }
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
              maxlength={capabilities?.limits.max_title_chars ?? 80}
              onInput={(event) => setTitle(event.currentTarget.value)}
              required
            />
          </div>
        </div>
        <SectionActions>
          <Button kind="primary" type="submit" busy={starting} disabled={!selectedSource}>
            Start recording
          </Button>
          <span class="actionstate">{formatBytes(data.storage.free_bytes)} free</span>
        </SectionActions>
      </form>
    </Section>
  );
  return (
    <div class="recording-workspace">
      {bridge.recordingsError.value && (
        <Notice tone="warn">
          The list could not refresh.{' '}
          <Button onClick={() => void bridge.refreshRecordings()}>Retry</Button>
        </Notice>
      )}
      <div class="recording-capture">
        {data.active.length > 0 && <RecordingList title="Recording now" items={data.active} />}
        {data.active.length === 0 || composing ? (
          composer
        ) : (
          <Button onClick={() => setComposing(true)}>New recording</Button>
        )}
      </div>
      <div class="recording-library">
        <RecordingList title="Your recordings" items={data.saved} />
      </div>
    </div>
  );
}

function RecordingList({ title, items }: { title: string; items: RecordingSnapshot[] }) {
  return (
    <Section title={title}>
      <div class="bridge-list">
        {items.length ? (
          items.map((item) => <RecordingCard key={item.id} item={item} />)
        ) : (
          <EmptyState>
            <strong>No recordings yet</strong>
            <p>
              Choose your input and start a recording. Finished WAV files appear here to download.
            </p>
          </EmptyState>
        )}
      </div>
    </Section>
  );
}

/** States whose recording is still in progress; stopping applies to these. */
const ACTIVE_STATES: readonly string[] = ['waiting-for-audio', 'recording', 'finalizing'];

function RecordingCard({ item }: { item: RecordingSnapshot }) {
  // Every affordance derives from the recording's own state and file, not
  // from which list happened to render it.
  const active = ACTIVE_STATES.includes(item.state);
  const stoppable = item.state === 'waiting-for-audio' || item.state === 'recording';
  const downloadable = !active && Boolean(item.file_name);
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
          {item.duplicate_packets > 0 && <span>{item.duplicate_packets} duplicate packets</span>}
        </div>
        {item.error && <div class="meta err">{item.error}</div>}
      </div>
      <div class="actions">
        {stoppable && (
          <Button kind="primary" onClick={() => void bridge.stopRecording(item.id)}>
            Stop and save
          </Button>
        )}
        {!active && (
          <>
            {downloadable && (
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
            )}
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
