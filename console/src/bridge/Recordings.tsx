import { useEffect, useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { DestructiveAction } from '../components/DestructiveAction';
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
export function Recordings({ requestedSource = '' }: { requestedSource?: string }) {
  const access = bridge.access.value;
  const capabilities = bridge.capabilities.value;
  if (!capabilities) {
    if (!bridge.capabilitiesError.value)
      return <EmptyState>Checking recording availability…</EmptyState>;
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
        <RecordingWorkspace requestedSource={requestedSource} />
      )}
    </section>
  );
}

function RecordingWorkspace({ requestedSource }: { requestedSource: string }) {
  const data = bridge.recordings.value;
  const capabilities = bridge.capabilities.value;
  const sources = Object.keys(bridge.status.value?.sources || {}).filter(
    (source) => source !== 'pending',
  );
  const [selection, setSelection] = useState({
    intent: requestedSource,
    source: requestedSource || sources[0] || '',
  });
  const source =
    selection.intent === requestedSource ? selection.source : requestedSource || selection.source;
  const setSource = (source: string) => setSelection({ intent: requestedSource, source });
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);
  const [composing, setComposing] = useState(Boolean(requestedSource));
  useEffect(() => {
    if (!requestedSource) return;
    setSource(requestedSource);
    setComposing(true);
  }, [requestedSource]);
  const selectedSource = source;
  const sourceAvailable = sources.includes(source) && !bridge.unreachable.value;
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
          if (!sourceAvailable) return;
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
              {!sources.includes(source) && (
                <option value={source}>{source || 'Choose a source'} (unavailable)</option>
              )}
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
          <Button
            kind="primary"
            type="submit"
            busy={starting}
            disabled={!sourceAvailable || bridge.recordingAction.value !== null}
          >
            Start recording
          </Button>
          {!sourceAvailable && (
            <span class="actionstate">
              Selected source unavailable. Reconnect it or choose another source.
            </span>
          )}
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
        <div class="recording-headroom">
          <strong>{formatBytes(data.storage.free_bytes)} free</strong>
          {capabilities && (
            <p>
              About{' '}
              {formatDuration(
                Math.max(0, data.storage.free_bytes - capabilities.limits.min_free_bytes) /
                  capabilities.format.bytes_per_second /
                  Math.max(1, data.active.length),
              )}{' '}
              of storage for {data.active.length > 1 ? 'these recordings' : 'one recording'}. Each
              recording stops at {formatDuration(capabilities.limits.max_duration_seconds)} or the
              storage reserve.
            </p>
          )}
        </div>
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
  const [result, setResult] = useState('');
  const pending = bridge.recordingAction.value;
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
        {active && bridge.capabilities.value && (
          <p class="help">
            Time remaining:{' '}
            {formatDuration(
              Math.max(
                0,
                bridge.capabilities.value.limits.max_duration_seconds - item.duration_seconds,
              ),
            )}
          </p>
        )}
        {result && <p role="status">{result}</p>}
      </div>
      <div class="actions">
        {stoppable && (
          <Button
            kind="primary"
            busy={pending?.id === item.id && pending.operation === 'stop'}
            disabled={pending !== null}
            onClick={async () => {
              const outcome = await bridge.stopRecording(item.id);
              setResult(
                outcome === 'refresh-failed'
                  ? 'Stop accepted. The list could not refresh; use Retry above.'
                  : outcome === 'failed'
                    ? bridge.error.value
                    : outcome === 'in-flight'
                      ? 'Another recording action is running. Try again when it finishes.'
                      : 'Recording saved.',
              );
            }}
          >
            {pending?.id === item.id && pending.operation === 'stop'
              ? 'Saving recording…'
              : 'Stop and save'}
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
            <DestructiveAction
              label="Delete"
              title={`Delete “${item.title}”?`}
              message="This permanently deletes the recording and its WAV file. Download a copy first if you want to keep it."
              disabled={pending !== null}
              run={async () => {
                const outcome = await bridge.deleteRecording(item.id);
                if (outcome === 'failed')
                  return bridge.error.value || 'Deletion failed. Try again.';
                if (outcome === 'in-flight')
                  return 'Another recording action is running. Try again when it finishes.';
                if (outcome === 'refresh-failed')
                  setResult('Deleted. The list could not refresh; use Retry above.');
                return undefined;
              }}
            />
          </>
        )}
      </div>
    </article>
  );
}
