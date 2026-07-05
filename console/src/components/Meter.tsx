import { dbfs, meterPct } from '../lib/format';
import { peakHold, status } from '../state/device';

const SCALE = ['−60', '−48', '−36', '−24', '−12', '−6', '0'];

/** Stereo level meter fed by the status poll; `foot` adds the RMS/peak/clip row. */
export function Meter({ foot = false }: { foot?: boolean }) {
  const m = status.value?.metrics;
  const hold = peakHold.value;
  const clip = m ? Math.max(m.peak_abs_left, m.peak_abs_right) >= m.clip_threshold_abs : false;
  return (
    <div class="meter">
      <div class="scale">
        {SCALE.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
      <MeterRow label="L" rms={m?.rms_left ?? 0} peak={hold.left} />
      <MeterRow label="R" rms={m?.rms_right ?? 0} peak={hold.right} />
      {foot && m && (
        <div class="meterfoot">
          <span>
            RMS {dbfs(m.rms_left)} / {dbfs(m.rms_right)}
          </span>
          <span>
            Peak {dbfs(m.peak_abs_left)} / {dbfs(m.peak_abs_right)}
          </span>
          <span class={`cliplamp${clip ? ' lit' : ''}`}>
            <i />
            CLIP
          </span>
          <span style="margin-left:auto">
            {m.noise_floor ? `noise floor ${dbfs(m.noise_floor)} dBFS` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/** One channel of the meter; standalone users wrap it in a `.meter` container. */
export function MeterRow({ label, rms, peak }: { label: string; rms: number; peak: number }) {
  return (
    <div class="meterrow">
      <span class="chn">{label}</span>
      <div class="track">
        <div class="zones" />
        <div class="fill" style={{ clipPath: `inset(0 ${100 - meterPct(rms)}% 0 0)` }} />
        <div class="peakhold" style={{ left: `calc(${meterPct(peak)}% - 1px)` }} />
      </div>
    </div>
  );
}
