import { usagePct, usageTone } from '../lib/format';

/**
 * A static utilization bar: how much of a bounded resource is in use, tinted by
 * remaining headroom. Distinct from `Meter`, which tracks a live audio signal.
 */
export function UsageBar({
  label,
  value,
  max,
  valueLabel,
  caption,
}: {
  label: string;
  value: number;
  max: number;
  valueLabel?: string;
  caption?: string;
}) {
  const pct = usagePct(value, max);
  const tone = usageTone(pct);
  return (
    <div class="usage">
      <div class="usage-head">
        <span class="usage-label">{label}</span>
        {valueLabel && <span class="usage-value">{valueLabel}</span>}
      </div>
      {/* The label, value, and caption carry the numbers for assistive tech; the
          bar is a visual reinforcement. */}
      <div class="usage-track" aria-hidden="true">
        <div class={`usage-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {caption && <span class="usage-caption">{caption}</span>}
    </div>
  );
}
