import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  CellSelect,
  Content,
  EmptyState,
  SettingRow,
  SettingToggle,
  useToast,
} from 'linen';
import { useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { dbfs } from '../../../shared/format';
import { Link } from '../../../shared/navigation';
import { setActiveAudioProfile, setAnalogPassthrough, setStream } from '../../lib/api';
import { withAccess } from '../../state/access';
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
import { ScreenTop } from '../ScreenTop';

/** What each activity is called, and what it means for the owner. */
const ACTIVITY: Record<AudioActivity, { word: string; meaning: string }> = {
  opening: { word: 'Connecting', meaning: 'Waiting for the device’s first answer.' },
  unavailable: {
    word: 'Unavailable',
    meaning: 'Live values return once the device answers again.',
  },
  setup: {
    word: 'Not on your Wi-Fi',
    meaning: 'Capture starts once the device is on your own network.',
  },
  fault: { word: 'Codec fault', meaning: 'The audio codec did not start.' },
  'no-bridge': {
    word: 'No bridge yet',
    meaning: 'The input is captured, but the device has nowhere to send it.',
  },
  paused: {
    word: 'Paused',
    meaning: 'Streaming is paused. Resume sends audio again; a restart resumes it too.',
  },
  quiet: {
    word: 'Quiet input',
    meaning: 'The input is silent, so the device keeps the stream open with silence.',
  },
  connecting: {
    word: 'Connecting to the bridge',
    meaning: 'Audio is playing, but nothing has left for the bridge since the last read.',
  },
  sending: {
    word: 'Sending audio',
    meaning: 'Audio is leaving for the bridge. The bridge console shows whether it arrives.',
  },
};

export function AudioHome() {
  const activity = audioActivity.value;
  return (
    <>
      {/* Stand-in for linen's live state label, which is still to come. */}
      <ScreenTop
        title="Audio"
        meta={<span className="text-sm text-text-secondary">{ACTIVITY[activity].word}</span>}
      />
      <Content>
        <div className="grid gap-4">
          <InputCard />
          <StreamCard activity={activity} />
        </div>
      </Content>
    </>
  );
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
        {/* Stand-in for linen's level gauge, which is still to come. */}
        {live ? (
          <p className="text-sm tabular-nums">
            Peak {dbfs(peakHold.value.left)} left, {dbfs(peakHold.value.right)} right · RMS{' '}
            {dbfs(live.metrics.rms_left)} left, {dbfs(live.metrics.rms_right)} right
          </p>
        ) : (
          <p className="text-sm text-text-secondary">Live levels are unavailable.</p>
        )}
        {clipCalloutVisible.value && (
          <p className="mt-2 text-sm text-warn">The input clipped since its levels were set.</p>
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
  if (!catalog || catalog.profiles.length === 0) return null;
  const choose = async (profileId: string) => {
    setSwitching(true);
    try {
      const done = await withAccess(() => setActiveAudioProfile(profileId));
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
    <SettingRow title="Profile" description="Applies a saved input, gain and attenuation at once.">
      <CellSelect
        aria-label="Profile"
        placeholder="Custom levels"
        choices={catalog.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
        value={catalog.active_profile_id ?? ''}
        disabled={switching}
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
      disabled={saving || locked !== null}
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
        <EmptyState title="No bridge yet" detail={ACTIVITY['no-bridge'].meaning}>
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
          <Button disabled={changing} onClick={() => void toggle()}>
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
