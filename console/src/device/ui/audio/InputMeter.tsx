import { computed } from '@preact/signals';
import { Gauge, Gauges } from 'linen';
import { LEVEL_FLOOR_DB, LEVEL_ZONES, levelDb, levelText } from '../../../shared/format';
import { liveStatus, peakHold } from '../../state/device';

/** Each channel's latest peak and its held peak, in dBFS, followed without rendering the card. */
const LEFT = {
  peak: computed(() => levelDb(liveStatus.value?.metrics.peak_abs_left ?? 0)),
  held: computed(() => levelDb(peakHold.value.left)),
};
const RIGHT = {
  peak: computed(() => levelDb(liveStatus.value?.metrics.peak_abs_right ?? 0)),
  held: computed(() => levelDb(peakHold.value.right)),
};
const CLIP_AT = computed(() => levelDb(liveStatus.value?.metrics.clip_threshold_abs ?? 32768));

/** Both channels' live level against the clipping mark, while the device answers. */
export function InputMeter() {
  const live = liveStatus.value;
  return live ? (
    <Gauges label="Input level">
      <Gauge
        label="Left"
        value={LEFT.peak}
        min={LEVEL_FLOOR_DB}
        max={0}
        zones={LEVEL_ZONES}
        marks={[
          { value: LEFT.held, kind: 'held', label: 'Recent peak' },
          { value: CLIP_AT, kind: 'set', label: 'Clipping' },
        ]}
        format={levelText}
      />
      <Gauge
        label="Right"
        value={RIGHT.peak}
        min={LEVEL_FLOOR_DB}
        max={0}
        zones={LEVEL_ZONES}
        marks={[
          { value: RIGHT.held, kind: 'held', label: 'Recent peak' },
          { value: CLIP_AT, kind: 'set', label: 'Clipping' },
        ]}
        format={levelText}
      />
    </Gauges>
  ) : (
    <p className="text-sm text-text-secondary">Live levels return when the device answers.</p>
  );
}
