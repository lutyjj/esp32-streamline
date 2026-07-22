import { setStream } from '../lib/api';
import { dbfs, duration } from '../lib/format';
import { useTransact, useWritable } from '../lib/hooks';
import { clipCalloutVisible, dismissClipCallout } from '../state/clipCallout';
import { bridgeConnection, noBridge, setupMode, status } from '../state/device';
import { blockingHealth } from '../state/health';
import { episodeDrops, lossCalloutVisible } from '../state/streamLoss';
import { Button } from './Button';
import { Card } from './Card';
import { Disclosure } from './Disclosure';
import { Kv } from './Kv';
import { Meter } from './Meter';
import { ActionState, TransactButton } from './Transact';

const BRIDGE_TILE: Record<string, { dot: string; label: string }> = {
  setup: { dot: '', label: '—' },
  unset: { dot: 'warn', label: 'Not set' },
  idle: { dot: '', label: 'Idle' },
  connecting: { dot: 'warn', label: 'Connecting' },
  sending: { dot: 'good', label: 'Sending' },
};

export function OverviewTab({
  onCalibrate,
  onSetupBridge,
}: {
  onCalibrate: () => void;
  onSetupBridge: () => void;
}) {
  const s = status.value;
  if (!s) return <section class="view active" />;

  const playing = s.metrics.playing;
  // Streaming can be paused from a device button, so the console must name
  // the state and offer the way out.
  const paused = !s.stream.enabled;
  const setup = setupMode.value;
  const bridgeless = noBridge.value;
  const bridge = bridgeConnection.value;
  const clips = s.metrics.clipped_samples_total;
  const showClipCallout = clipCalloutVisible.value;
  const fault = blockingHealth.value;
  const rms = Math.max(s.metrics.rms_left, s.metrics.rms_right);

  // One verdict in priority order; each state names itself and its cause.
  const statusTile = fault
    ? { dot: 'bad', label: 'Fault', sub: 'audio hardware needs attention' }
    : setup
      ? { dot: 'warn', label: 'Setup', sub: 'waiting for first-time setup' }
      : paused
        ? { dot: 'warn', label: 'Paused', sub: 'streaming is paused' }
        : playing
          ? {
              dot: 'good',
              label: bridgeless ? 'Signal' : 'Streaming',
              sub: 'input carries signal',
            }
          : { dot: '', label: 'Idle', sub: 'input is quiet' };

  const diagRows: [string, string][] = [
    ['Last boot', s.diagnostics?.reset_reason || '—'],
    ...(s.system ? [['Uptime', duration(s.system.uptime_seconds)] as [string, string]] : []),
    ['Config source', s.config_source],
    ['Packets sent', `${s.metrics.packets} · ${s.metrics.queue_drops_total} dropped`],
    [
      'Network',
      `${s.metrics.network_errors_total} send errors · ${s.metrics.reconnects_total} reconnects`,
    ],
    [
      'Send stalls',
      `${s.metrics.send_stalls_total} over 100 ms · longest ${s.metrics.longest_send_stall_ms} ms`,
    ],
    ['Capture', `${s.metrics.read_errors} read errors · ${s.metrics.short_reads} short reads`],
    ['Sequence', String(s.metrics.sequence)],
    ['Detector floor', `${s.metrics.noise_floor} RMS`],
    ...(s.diagnostics?.last_ota
      ? [['Last update', s.diagnostics.last_ota] as [string, string]]
      : []),
    ...(s.diagnostics?.last_fallback
      ? [['Last AP fallback', s.diagnostics.last_fallback] as [string, string]]
      : []),
  ];

  return (
    <>
      {fault && (
        <div class="card callout bad">
          <div>
            <strong>{fault.detail}</strong>
            {fault.remedy && <span class="sub"> {fault.remedy}</span>}
          </div>
        </div>
      )}

      {lossCalloutVisible.value && (
        <div class="card callout bad">
          <div>
            <strong>Audio is being dropped.</strong>
            <span class="sub">
              {` ${episodeDrops.value} packets were lost in the current episode — listeners hear gaps. The usual causes are a stalling Wi-Fi link or a bridge that cannot keep up; Diagnostics below shows send stalls and drop totals.`}
            </span>
          </div>
        </div>
      )}

      {paused && !setup && <PausedCallout />}

      {bridgeless && (
        <div class="card callout">
          <div>
            <strong>No bridge yet.</strong>
            <span class="sub">
              {' StreamLine is capturing audio but has nowhere to send it. The guided setup' +
                ' connects it in about a minute.'}
            </span>
          </div>
          <div class="actions">
            <Button onClick={onSetupBridge}>Set up bridge</Button>
          </div>
        </div>
      )}

      {showClipCallout && (
        <div class="card callout">
          <div>
            <strong>Loud passages are clipping.</strong>
            <span class="sub">
              {` ${clips} samples hit full scale since the levels were last set — the recording is distorted at the bridge. Calibration fixes this in about a minute.`}
            </span>
          </div>
          <div class="actions">
            <Button onClick={onCalibrate}>Calibrate levels</Button>
            <Button onClick={dismissClipCallout}>Dismiss</Button>
          </div>
        </div>
      )}

      <div class="healthstrip">
        <div class="health">
          <span class="eyebrow">Status</span>
          <span class="val">
            <span class={`statusdot ${statusTile.dot}`} />
            <span>{statusTile.label}</span>
          </span>
          <span class="sub">{statusTile.sub}</span>
        </div>
        <div class="health">
          <span class="eyebrow">Signal</span>
          <span class="val">{dbfs(rms)} dBFS</span>
          <span class="sub">
            {clips ? `${clips} clipped since levels were set` : 'no clipping'}
          </span>
        </div>
        <div class="health">
          <span class="eyebrow">Wi-Fi</span>
          <span class="val">{s.wifi.ssid || '—'}</span>
          <span class="sub">
            {setup
              ? `setup network at ${s.wifi.ap_ip}`
              : `${s.wifi.rssi} dBm · ${s.wifi.hostname || s.wifi.sta_ip}`}
          </span>
        </div>
        <div class="health">
          <span class="eyebrow">Bridge</span>
          <span class="val">
            <span class={`statusdot ${BRIDGE_TILE[bridge].dot}`} />
            <span>{BRIDGE_TILE[bridge].label}</span>
          </span>
          <span class="sub">
            {bridgeless
              ? 'no bridge configured yet'
              : `${s.target.target_host}:${s.target.target_port}${
                  s.target.transport === 'tls-psk' ? ' · encrypted' : ''
                }`}
          </span>
        </div>
      </div>

      <Card title="Input level">
        <div class="card-section">
          <Meter foot />
        </div>
      </Card>

      <Card>
        <Disclosure title="Diagnostics">
          <Kv rows={diagRows} />
        </Disclosure>
      </Card>
    </>
  );
}

/**
 * Streaming was paused — usually by a device button assigned "Start/stop
 * streaming". The device keeps capturing so the meter stays live; this
 * callout names the state and resumes it. A reboot also resumes streaming.
 */
function PausedCallout() {
  const writable = useWritable();
  const transact = useTransact();
  return (
    <div class="card callout">
      <div>
        <strong>Streaming is paused.</strong>
        <span class="sub">
          {' The device keeps measuring its input but sends nothing to the bridge — a device' +
            ' button or an API client paused it.'}
        </span>
      </div>
      <div class="actions">
        <TransactButton
          transact={transact}
          disabled={!writable}
          onClick={() =>
            transact.run(() => setStream({ enabled: true }), {
              busyText: 'Resuming…',
              okText: 'Streaming resumed',
            })
          }
        >
          Resume
        </TransactButton>
        <ActionState state={transact.state} />
      </div>
    </div>
  );
}
