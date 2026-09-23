import { CopyButton } from '../components/CopyButton';
import { Disclosure } from '../components/Disclosure';
import { Kv } from '../components/Kv';
import { MeterRow } from '../components/Meter';
import type { SourceSnapshot } from '../generated/bridge';
import { dbfs } from '../lib/format';
import { formatBytes, formatDuration } from './format';
import { bridgeBase } from './http';
import { playbackUrl } from './playback';
import { receptionSummary } from './reception';
import { StateChip } from './StateChip';
import { bridge } from './state';

export function IncomingSource({ ip, source }: { ip: string; source: SourceSnapshot }) {
  const previous = useRef<SourceSnapshot>();
  const summary = useMemo(() => receptionSummary(source, previous.current), [source]);
  useEffect(() => {
    previous.current = bridge.unreachable.value ? undefined : source;
  }, [source]);
  const streamUrl = playbackUrl(
    bridge.status.value?.public_url,
    bridgeBase(),
    window.location.origin,
    ip,
  );
  return (
    <section class="incoming-source">
      <div class="source-monitor">
        <div class="source-head">
          <h2>
            Audio input <span>{ip}</span>
          </h2>
          <StateChip state={bridge.unreachable.value ? 'unavailable' : source.lifecycle.state} />
        </div>
        {bridge.unreachable.value ? (
          <p>Live readings are unavailable. Waiting for the bridge to reconnect.</p>
        ) : (
          <div class="bridge-meter">
            <MeterRow label="L" rms={source.levels.rms_left} peak={source.levels.peak_left} />
            <MeterRow label="R" rms={source.levels.rms_right} peak={source.levels.peak_right} />
            <div class="meterfoot">
              RMS {dbfs(source.levels.rms_left)} / {dbfs(source.levels.rms_right)} dBFS
            </div>
          </div>
        )}
        <p class="listener-status">
          {bridge.unreachable.value
            ? 'Player connections are last known.'
            : source.clients === 0
              ? 'No players connected'
              : `${source.clients} player connection${source.clients === 1 ? '' : 's'}`}
        </p>
        {!bridge.unreachable.value && <p>{summary}</p>}
        <Disclosure title="Reception details">
          <Kv
            rows={[
              ['Received', formatBytes(source.bytes)],
              ['Lost packets', String(source.lost)],
              ['Uptime', formatDuration(source.uptime_seconds)],
              ['Buffered packets', `${source.buffered_packets} / ${source.playout_buffer_packets}`],
              ['Concealed packets (session)', String(source.concealed)],
              ['Late packets (session)', String(source.late)],
              ['Buffer underruns (session)', String(source.underruns)],
              ['Slow players (session)', String(source.slow_clients)],
              ['Player queue drops (session)', String(source.client_queue_drops)],
              ...source.client_streams.map((client): [string, string] => [
                `Player ${client.id}`,
                `${client.queue_depth} queued, ${client.queue_drops} dropped`,
              ]),
            ]}
          />
        </Disclosure>
      </div>
      <div class="player-handoff">
        <h3>Listen in your player</h3>
        <p>
          Add this address to a player that supports HTTP WAV streams. Playback happens there, not
          in this console.
        </p>
        {streamUrl ? (
          <>
            <label class="field">
              Stream address
              <input readOnly value={streamUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <CopyButton kind="primary" value={streamUrl} copied="Playback URL copied">
              Copy playback URL
            </CopyButton>
          </>
        ) : (
          <p>
            Set public_url in the bridge configuration to the address your player can reach, then
            restart the bridge. Use its published HTTP address, not the Home Assistant console
            address.
          </p>
        )}
        <a class="record-link" href={`#/recordings?source=${encodeURIComponent(ip)}`}>
          Record this audio
        </a>
      </div>
    </section>
  );
}

import { useEffect, useMemo, useRef } from 'preact/hooks';
