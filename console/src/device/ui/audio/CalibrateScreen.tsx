import {
  Actions,
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  Content,
  Notice,
  Progress,
  Steps,
  Swap,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { useEffect, useState } from 'react';
import { getSetAudioUrl, type StatusResponse } from '../../../generated/api';
import { Link, navigate } from '../../../shared/navigation';
import { CAL_ATTEN_MAX } from '../../lib/calibration';
import { withAccess } from '../../state/access';
import {
  CALIBRATION_STEPS,
  type Calibration,
  CalibrationGuide,
  calibrationHeld,
  calibrationStep,
  calibrationUnderway,
  deviceCalibration,
} from '../../state/calibration';
import { status } from '../../state/device';
import { updateLock } from '../../state/ota';
import { ScreenTop } from '../ScreenTop';
import { InputMeter } from './InputMeter';

const TRAIL = [{ href: '/audio', label: 'Audio' }];

/** What the second step asks, which it still says while an update holds it. */
const PLAY_LOUD =
  'Play the loudest material you will stream, at the volume you will use. The device raises the attenuation until nothing clips.';

/** Calibrate: measure the quiet, then find the attenuation loud material needs. */
export function CalibrateScreen() {
  const known = status.value;
  const held = calibrationHeld.value;
  return (
    <>
      <ScreenTop title="Calibrate" trail={TRAIL} />
      <Content>
        {held ? (
          <Notice tone="warn" title="Calibration cannot run now." description={held} />
        ) : (
          known && <Guide known={known} />
        )}
      </Content>
    </>
  );
}

function Guide({ known }: { known: StatusResponse }) {
  const toast = useToast();
  const [{ guide, entry }] = useState(() => {
    const { input_line, input_gain, adc_attenuation_db } = known.audio;
    const entry = { input_line, input_gain, adc_attenuation_db };
    const ceiling = known.capabilities.adc_atten_max_db || CAL_ATTEN_MAX;
    return { guide: new CalibrationGuide(entry, ceiling, deviceCalibration(entry)), entry };
  });
  const state = guide.state.value;
  useUnsavedChanges(calibrationUnderway(state), { name: 'the calibration' });

  // Once closed, the guide is done with: back to Audio, after the guard has
  // seen it close. Leaving another way closes it too, putting back what it
  // set, unless the owner chose to leave a failed restore as it is.
  useEffect(() => {
    if (state.phase === 'closed') navigate('/audio');
  }, [state.phase]);
  useEffect(
    () => () => {
      const phase = guide.state.value.phase;
      if (phase === 'closed' || phase === 'restore-failed') return;
      void guide.close().then(() => {
        const after = guide.state.value;
        if (after.phase === 'restore-failed') toast.show({ text: after.reason, sticky: true });
      });
    },
    [guide, toast],
  );

  const cancel = async () => {
    await guide.close();
    const after = guide.state.value;
    if (after.phase === 'closed' && after.restored) {
      toast.show({ text: `The attenuation is back at ${entry.adc_attenuation_db} dB.` });
    }
  };
  const finish = (attenuation: number) => {
    toast.show({ text: `Attenuation set to ${attenuation} dB.` });
    void guide.close();
  };

  // Finding the level writes the attenuation, which waits while an update runs.
  const held = updateLock(getSetAudioUrl());
  const step = calibrationStep(state);
  const measure = () => void guide.measureQuiet();
  const listen = () => void withAccess(() => guide.findLevel());
  const leaving = step === null || step === 'done';
  return (
    <Card>
      <CardHead
        title="Find the attenuation"
        description="The device listens to the running input, first quiet, then at its loudest, and keeps the attenuation that stops the loudest part clipping."
      />
      <CardBody>
        {step && <Steps label="Calibration" steps={CALIBRATION_STEPS} current={step} />}
        <Swap view={state.phase} stepped>
          <Phase
            state={state}
            measure={measure}
            listen={listen}
            held={held}
            finish={finish}
            retry={() => void guide.close()}
          />
        </Swap>
        {!leaving && (
          <Actions className="justify-end">
            <Button onClick={() => void cancel()}>Cancel</Button>
            <Next state={state} measure={measure} listen={listen} held={held} />
          </Actions>
        )}
      </CardBody>
    </Card>
  );
}

/** The step forward a phase asks for, beside the way out. */
function Next({
  state,
  measure,
  listen,
  held,
}: {
  state: Calibration;
  measure: () => void;
  listen: () => void;
  held: string | null;
}) {
  if (state.phase === 'pause-source')
    return (
      <Button variant="primary" onClick={measure}>
        Measure the quiet
      </Button>
    );
  if (state.phase === 'play-loud')
    return (
      <Button variant="primary" disabled={held !== null} onClick={listen}>
        Find the level
      </Button>
    );
  return null;
}

function Phase({
  state,
  measure,
  listen,
  finish,
  retry,
  held,
}: {
  state: Calibration;
  measure: () => void;
  listen: () => void;
  /** Why the level cannot be looked for now, or null. */
  held: string | null;
  finish: (attenuation: number) => void;
  retry: () => void;
}) {
  switch (state.phase) {
    case 'pause-source':
      return (
        <p className="text-sm text-text-secondary">
          Pause the source. The device measures the quiet first, for about four seconds.
        </p>
      );
    case 'measuring-quiet':
      return <Progress label="Measuring the quiet" value={state.progress} />;
    case 'quiet-refused':
      return (
        <Notice
          tone="warn"
          title="The quiet was not measured."
          description={state.reason}
          action={<Button onClick={measure}>Measure again</Button>}
        />
      );
    case 'play-loud':
      return (
        <p className="text-sm text-text-secondary">
          {held ? `${PLAY_LOUD} ${held}` : PLAY_LOUD}
        </p>
      );
    case 'listening':
      return (
        <div className="grid gap-4">
          <Progress label={`Listening at ${state.attenuation} dB of attenuation`} />
          <InputMeter />
        </div>
      );
    case 'loud-refused':
      return (
        <Notice
          tone="warn"
          title="The level was not found."
          description={held ?? state.reason}
          action={
            <Button disabled={held !== null} onClick={listen}>
              Listen again
            </Button>
          }
        />
      );
    case 'done':
      return (
        <Notice
          tone="positive"
          title={`The attenuation is ${state.attenuation} dB.`}
          description={`The loudest peak reached ${state.peakDb} dBFS without clipping. The device keeps this level.`}
          action={
            <Button variant="primary" onClick={() => finish(state.attenuation)}>
              Done
            </Button>
          }
        />
      );
    case 'restoring':
      return <Progress label="Putting the attenuation back" />;
    case 'restore-failed':
      return (
        <Notice
          tone="danger"
          title="The attenuation was not put back."
          description={state.reason}
          action={
            <Actions>
              <Button onClick={retry}>Try again</Button>
              <Link href="/audio" className={buttonClass()}>
                Leave it
              </Link>
            </Actions>
          }
        />
      );
    case 'closed':
      return null;
  }
}
