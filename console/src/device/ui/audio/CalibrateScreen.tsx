import {
  Button,
  buttonClass,
  Card,
  CardBody,
  Content,
  Notice,
  Progress,
  Steps,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, navigate } from '../../../shared/navigation';
import { getSetAudioUrl, type StatusResponse } from '../../lib/api';
import { CAL_ATTEN_MAX } from '../../lib/calibration';
import { withAccess } from '../../state/access';
import {
  CALIBRATION_STEPS,
  type Calibration,
  CalibrationGuide,
  calibrationStep,
  calibrationUnderway,
  deviceCalibration,
} from '../../state/calibration';
import { status } from '../../state/device';
import { updateLock } from '../../state/ota';
import { ScreenTop } from '../ScreenTop';
import { InputMeter } from './InputMeter';

const TRAIL = [{ href: '/audio', label: 'Audio' }];

/** Calibrate: measure the quiet, then find the attenuation loud material needs. */
export function CalibrateScreen() {
  const known = status.value;
  return (
    <>
      <ScreenTop title="Calibrate" trail={TRAIL} />
      <Content>{known && <Guide known={known} />}</Content>
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
  const leaving = step === null || step === 'done';
  return (
    <div className="grid gap-4">
      {step && <Steps label="Calibration" steps={CALIBRATION_STEPS} current={step} />}
      <Card>
        <CardBody>
          <Phase
            state={state}
            measure={() => void guide.measureQuiet()}
            listen={() => void withAccess(() => guide.findLevel())}
            held={held}
            finish={finish}
            retry={() => void guide.close()}
          />
          {!leaving && (
            <div className="mt-5 flex justify-end">
              <Button onClick={() => void cancel()}>Cancel</Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
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
        <Ask
          title="Pause the source"
          text="The device measures the quiet first, for about four seconds."
          action={
            <Button variant="primary" onClick={measure}>
              Measure the quiet
            </Button>
          }
        />
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
        <Ask
          title="Play the loudest part"
          text={
            held ??
            'Play the loudest material you will stream, at the volume you will use. The device raises the attenuation until nothing clips.'
          }
          action={
            <Button variant="primary" disabled={held !== null} onClick={listen}>
              Find the level
            </Button>
          }
        />
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
            <div className="flex flex-wrap gap-2">
              <Button onClick={retry}>Try again</Button>
              <Link href="/audio" className={buttonClass()}>
                Leave it
              </Link>
            </div>
          }
        />
      );
    case 'closed':
      return null;
  }
}

function Ask({ title, text, action }: { title: string; text: string; action: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-3">
      <div>
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{text}</p>
      </div>
      {action}
    </div>
  );
}
