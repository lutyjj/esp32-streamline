import { computed } from '@preact/signals';
import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  CellSelect,
  Content,
  EmptyState,
  Gauge,
  Gauges,
  type GaugeZone,
  Notice,
  SettingRow,
  SettingToggle,
  useToast,
} from 'linen';
import { useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { LEVEL_FLOOR_DB, levelDb } from '../../../shared/format';
import { Link } from '../../../shared/navigation';
import {
  getSetAudioProfileUrl,
  setActiveAudioProfile,
  setAnalogPassthrough,
  setStream,
} from '../../lib/api';
import { withAccess, withRestart } from '../../state/access';
import { type AudioActivity, audioActivity } from '../../state/activity';
import { clipCalloutVisible } from '../../state/clipCallout';
import {
  audioProfiles,
  liveStatus,
  loadAudioProfiles,
  passthroughLocked,
  peakHold,
  status,
} from '../../state/device';
import { blockingHealth } from '../../state/health';
import { updateLock } from '../../state/ota';
import { ACTIVITY, ActivityStatus } from '../activityWords';
import { ScreenTop } from '../ScreenTop';

export function AudioHome() {
  const activity = audioActivity.value;
  return (
    <>
      <ScreenTop title="Audio" meta={<ActivityStatus activity={activity} />} />
      <Content>
        <div className="grid gap-4">
          <InputCard />
          <StreamCard activity={activity} />
        </div>
      </Content>
    </>
  );
}

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

/** Hot near the top of the scale, and clipping in its last decibel. */
const ZONES: readonly GaugeZone[] = [
  { from: LEVEL_FLOOR_DB, to: -6, tone: 'accent' },
  { from: -6, to: -1, tone: 'warn' },
  { from: -1, to: 0, tone: 'danger' },
];

function dbText(value: number): string {
  return value <= LEVEL_FLOOR_DB ? 'silent' : `${value.toFixed(1)} dB`;
}

function InputCard() {
  const live = liveStatus.value;
  const known = status.value;
  const lines = known?.capabilities.input_lines ?? [];
  const audio = known?.audio;
  const line = lines.find((entry) => entry.line === audio?.input_line)?.label;
  return (
    <Card>
      <CardHead
        title="Input"
        description={
          audio
            ? `${line ?? `Line ${audio.input_line}`} · gain ${audio.input_gain} · attenuation ${audio.adc_attenuation_db} dB`
            : undefined
        }
      />
      <CardBody>
        {live ? (
          <Gauges label="Input level">
            <Gauge
              label="Left"
              value={LEFT.peak}
              min={LEVEL_FLOOR_DB}
              max={0}
              zones={ZONES}
              marks={[
                { value: LEFT.held, kind: 'held', label: 'Recent peak' },
                { value: CLIP_AT, kind: 'set', label: 'Clipping' },
              ]}
              format={dbText}
            />
            <Gauge
              label="Right"
              value={RIGHT.peak}
              min={LEVEL_FLOOR_DB}
              max={0}
              zones={ZONES}
              marks={[
                { value: RIGHT.held, kind: 'held', label: 'Recent peak' },
                { value: CLIP_AT, kind: 'set', label: 'Clipping' },
              ]}
              format={dbText}
            />
          </Gauges>
        ) : (
          <p className="text-sm text-text-secondary">Live levels return when the device answers.</p>
        )}
        {clipCalloutVisible.value && (
          <Notice
            className="mt-4"
            tone="warn"
            title="The input clipped since its levels were set."
            description="Turn the source down or raise the attenuation until the loudest part stays under the clipping mark."
          />
        )}
      </CardBody>
      <ProfileRow />
      <PassthroughRow />
    </Card>
  );
}

function ProfileRow() {
  const toast = useToast();
  const catalog = audioProfiles.value;
  const [switching, setSwitching] = useState(false);
  // Switching can restart the device, which waits while an update runs.
  const held = updateLock(getSetAudioProfileUrl());
  if (!catalog || catalog.profiles.length === 0) return null;
  const choose = async (profileId: string) => {
    setSwitching(true);
    try {
      const done = await withRestart('the profile change', () => setActiveAudioProfile(profileId));
      if (done) {
        await loadAudioProfiles();
        const name = catalog.profiles.find((profile) => profile.id === profileId)?.name;
        toast.show({ text: name ? `Switched to ${name}.` : 'Back to custom levels.' });
      }
    } catch (error) {
      toast.show({ text: `The profile did not switch: ${errorMessage(error)}`, sticky: true });
    } finally {
      setSwitching(false);
    }
  };
  return (
    <SettingRow
      title="Profile"
      description={held ?? 'Applies a saved input, gain and attenuation at once.'}
    >
      <CellSelect
        aria-label="Profile"
        placeholder="Custom levels"
        choices={catalog.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
        value={catalog.active_profile_id ?? ''}
        disabled={switching || held !== null}
        onValueChange={(next) => void choose(next)}
      />
    </SettingRow>
  );
}

function PassthroughRow() {
  const toast = useToast();
  const known = status.value;
  const output = known?.capabilities.analog_passthrough;
  const [saving, setSaving] = useState(false);
  if (!known || !output) return null;
  const locked = passthroughLocked.value;
  const fault = known.analog_passthrough.fault;
  const turn = async (enabled: boolean) => {
    setSaving(true);
    try {
      await withAccess(() => setAnalogPassthrough({ enabled }));
    } catch (error) {
      toast.show({
        text: `Analog passthrough did not change: ${errorMessage(error)}`,
        sticky: true,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingToggle
      title="Analog passthrough"
      description={
        locked ??
        fault ??
        `Sends the input straight to ${output.label} at line level. Gain and calibration do not change its volume.`
      }
      label="Analog passthrough"
      checked={known.analog_passthrough.enabled}
      busy={saving}
      disabled={locked !== null}
      onCheckedChange={(enabled) => void turn(enabled)}
    />
  );
}

function StreamCard({ activity }: { activity: AudioActivity }) {
  const toast = useToast();
  const live = liveStatus.value;
  const [changing, setChanging] = useState(false);
  const fault = blockingHealth.value;
  const target = status.value?.target;

  if (activity === 'no-bridge') {
    return (
      <Card>
        <CardHead title="Stream" />
        <EmptyState title="No bridge yet" description={ACTIVITY['no-bridge'].meaning}>
          <Link href="/bridge" className={buttonClass('primary')}>
            Connect a bridge
          </Link>
        </EmptyState>
      </Card>
    );
  }

  const enabled = live?.stream.enabled ?? true;
  const toggle = async () => {
    setChanging(true);
    try {
      await withAccess(() => setStream({ enabled: !enabled }));
    } catch (error) {
      toast.show({ text: `Streaming did not change: ${errorMessage(error)}`, sticky: true });
    } finally {
      setChanging(false);
    }
  };
  return (
    <Card>
      <CardHead
        title="Stream"
        description={fault ? (fault.remedy ?? fault.detail) : ACTIVITY[activity].meaning}
      >
        {live?.mode === 'provisioned' && (
          <Button busy={changing} onClick={() => void toggle()}>
            {enabled ? 'Pause streaming' : 'Resume streaming'}
          </Button>
        )}
      </CardHead>
      {target?.target_host && (
        <SettingRow title="Bridge">
          <Link href="/bridge" className="font-mono text-sm">
            {target.target_host}:{target.target_port}
          </Link>
        </SettingRow>
      )}
    </Card>
  );
}
