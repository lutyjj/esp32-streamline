import { dbfs } from '../lib/format';
import { clipCalloutVisible, dismissClipCallout } from '../state/clipCallout';
import { noBridge, packetsMoving, setupMode, status } from '../state/device';
import { Disclosure } from './Disclosure';
import { Kv } from './Kv';
import { Meter } from './Meter';

export function OverviewTab({ onCalibrate }: { onCalibrate: () => void }) {
  const s = status.value;
  if (!s) return <section class="view active" />;

  const playing = s.metrics.playing;
  const setup = setupMode.value;
  const bridgeless = noBridge.value;
  const moving = packetsMoving.value;
  const clips = s.metrics.clipped_samples_total;
  const showClipCallout = clipCalloutVisible.value;
  const rms = Math.max(s.metrics.rms_left, s.metrics.rms_right);

  const diagRows: [string, string][] = [
    ['Last boot', s.diagnostics?.reset_reason || '—'],
    ['Config source', s.config_source],
    ['Packets sent', `${s.metrics.packets} · ${s.metrics.queue_drops_total} dropped`],
    [
      'Network',
      `${s.metrics.network_errors_total} send errors · ${s.metrics.reconnects_total} reconnects`,
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
      {showClipCallout && (
        <div class="card callout">
          <div>
            <strong>Loud passages are clipping.</strong>
            <span class="sub">
              {` ${clips} samples hit full scale since the levels were last set — the recording is distorted at the bridge. Calibration fixes this in about a minute.`}
            </span>
          </div>
          <div class="actions">
            <button class="btn secondary" type="button" onClick={onCalibrate}>
              Calibrate levels
            </button>
            <button class="btn secondary" type="button" onClick={dismissClipCallout}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div class="healthstrip">
        <div class="health">
          <span class="eyebrow">Status</span>
          <span class="val">
            <span class={`statusdot ${setup ? 'warn' : playing ? 'good' : ''}`} />
            <span>
              {setup ? 'Setup' : playing ? (bridgeless ? 'Signal' : 'Streaming') : 'Idle'}
            </span>
          </span>
          <span class="sub">
            {setup
              ? 'waiting for first-time setup'
              : playing
                ? 'input carries signal'
                : 'input is quiet'}
          </span>
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
            <span
              class={`statusdot ${bridgeless ? 'warn' : moving ? 'good' : playing ? 'warn' : ''}`}
            />
            <span>
              {setup
                ? '—'
                : bridgeless
                  ? 'Not set'
                  : moving
                    ? 'Sending'
                    : playing
                      ? 'Connecting'
                      : 'Idle'}
            </span>
          </span>
          <span class="sub">
            {bridgeless
              ? 'point it at your bridge in the Network tab'
              : `${s.target.target_host}:${s.target.target_port}`}
          </span>
        </div>
      </div>

      <div class="card">
        <h2>Input level</h2>
        <div style="margin-top:12px">
          <Meter foot />
        </div>
      </div>

      <div class="card">
        <Disclosure title="Diagnostics">
          <Kv rows={diagRows} />
        </Disclosure>
      </div>
    </>
  );
}
