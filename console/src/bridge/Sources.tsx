import { CopyButton } from '../components/CopyButton';
import { Disclosure } from '../components/Disclosure';
import { Kv } from '../components/Kv';
import { MeterRow } from '../components/Meter';
import type { SourceSnapshot } from '../generated/bridge';
import { dbfs } from '../lib/format';
import { formatBytes, formatDuration } from './format';
import { bridgeBase } from './http';
import { StateChip } from './StateChip';
import { bridge } from './state';

export function IncomingSource({ ip, source }: { ip: string; source: SourceSnapshot }) {
  const streamUrl = new URL(`${bridgeBase()}/streamline.wav`, window.location.origin);
  streamUrl.searchParams.set('source', ip);
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
          {source.clients === 0
            ? 'No players connected'
            : `${source.clients} player connection${source.clients === 1 ? '' : 's'}`}
        </p>
        <Disclosure title="Reception details">
          <Kv
            rows={[
              ['Received', formatBytes(source.bytes)],
              ['Lost packets', String(source.lost)],
              ['Uptime', formatDuration(source.uptime_seconds)],
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
        <label class="field">
          Stream address
          <input
            readOnly
            value={streamUrl.toString()}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <CopyButton kind="primary" value={streamUrl.toString()} copied="Playback URL copied">
          Copy playback URL
        </CopyButton>
        <a class="record-link" href="#/recordings">
          Record this audio
        </a>
      </div>
    </section>
  );
}
