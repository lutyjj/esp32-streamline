import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  CellSelect,
  Content,
  EmptyState,
  Notice,
  SettingRow,
  SettingToggle,
  useToast,
} from 'linen';
import { useEffect, useState } from 'react';
import {
  getSetAudioProfileUrl,
  setAnalogPassthrough,
  setAudioProfile,
  setStream,
} from '../../../generated/api';
import { errorMessage } from '../../../shared/errors';
import { Link, replacePath, usePathname } from '../../../shared/navigation';
import { withAccess, withRestart } from '../../state/access';
import { type AudioActivity, audioActivity } from '../../state/activity';
import { clipCalloutVisible } from '../../state/clipCallout';
import {
  audioProfiles,
  liveStatus,
  loadAudioProfiles,
  passthroughLocked,
  status,
} from '../../state/device';
import { blockingHealth } from '../../state/health';
import { updateLock } from '../../state/ota';
import { ACTIVITY, ActivityStatus } from '../activityWords';
import { sectionOf } from '../places';
import { ScreenTop } from '../ScreenTop';
import { CalibrateScreen } from './CalibrateScreen';
import { InputMeter } from './InputMeter';
import { LevelsScreen } from './LevelsScreen';
import { levelsWords } from './levelsWords';
import { ProfilesScreen } from './ProfilesScreen';

const TASKS = ['levels', 'calibrate', 'profiles'] as const;
type Task = (typeof TASKS)[number];

/** The Audio place: the input and the stream at a glance, and the tasks that tune them. */
export function AudioScreen() {
  const section = sectionOf(usePathname());
  const task = TASKS.find((entry) => entry === section);
  useEffect(() => {
    if (section !== undefined && task === undefined) replacePath('/audio');
  }, [section, task]);
  return task ? <AudioTask task={task} /> : <AudioHome />;
}

function AudioTask({ task }: { task: Task }) {
  if (task === 'levels') return <LevelsScreen />;
  if (task === 'calibrate') return <CalibrateScreen />;
  return <ProfilesScreen />;
}

function AudioHome() {
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

function InputCard() {
  const known = status.value;
  return (
    <Card>
      <CardHead
        title="Input"
        description={known ? levelsWords(known.audio, known.capabilities.input_lines) : undefined}
      >
        <Link href="/audio/levels" className={buttonClass()}>
          Adjust input
        </Link>
      </CardHead>
      <CardBody>
        <InputMeter />
        {clipCalloutVisible.value && (
          <Notice
            className="mt-4"
            tone="warn"
            title="The input clipped since its levels were set."
            description="Turn the source down, or let calibration find the attenuation that keeps the loudest part under the clipping mark."
            action={
              <Link href="/audio/calibrate" className={buttonClass()}>
                Calibrate
              </Link>
            }
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
  if (!catalog) return null;
  const saved = catalog.profiles.length > 0;
  const choose = async (profileId: string) => {
    setSwitching(true);
    try {
      const done = await withRestart('the profile change', () =>
        setAudioProfile({ profile_id: profileId }),
      );
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
      description={
        held ??
        (saved
          ? 'Applies a saved input, gain and attenuation at once.'
          : 'None saved yet. A profile keeps the applied levels under a name.')
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {saved && (
          <CellSelect
            aria-label="Profile"
            placeholder="Custom levels"
            choices={catalog.profiles.map((profile) => ({
              value: profile.id,
              label: profile.name,
            }))}
            value={catalog.active_profile_id ?? ''}
            disabled={switching || held !== null}
            onValueChange={(next) => void choose(next)}
          />
        )}
        <Link href="/audio/profiles" className={buttonClass()}>
          Manage profiles
        </Link>
      </div>
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
