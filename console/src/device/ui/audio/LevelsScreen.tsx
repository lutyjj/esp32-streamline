import { useMutation } from '@tanstack/preact-query';
import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  Content,
  Form,
  NumberField,
  Select,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { useEffect, useState } from 'react';
import { getSetAudioUrl, type StatusResponse } from '../../../generated/api';
import { Link } from '../../../shared/navigation';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { status } from '../../state/device';
import {
  discardLevels,
  editLevel,
  keptLevels,
  type Level,
  levelsDraft,
  levelsUnsaved,
  saveLevels,
} from '../../state/levels';
import { updateLock } from '../../state/ota';
import { ScreenTop } from '../ScreenTop';
import { InputMeter } from './InputMeter';

const TRAIL = [{ href: '/audio', label: 'Audio' }];

/** Adjust input: the line, gain and attenuation as one draft, under its own live meter. */
export function LevelsScreen() {
  const known = status.value;
  return (
    <>
      <ScreenTop title="Adjust input" trail={TRAIL} />
      <Content>{known && <LevelsEditor known={known} />}</Content>
    </>
  );
}

function LevelsEditor({ known }: { known: StatusResponse }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => levelsDraft(known));
  const save = useMutation(
    {
      mutationFn: () => saveLevels(draft),
      onSuccess: (done) => {
        if (!done) return;
        setDraft((current) => keptLevels(current));
        toast.show({ text: 'Input levels saved.' });
      },
    },
    queryClient,
  );
  const saving = save.isPending;
  // Untouched fields follow the device, so a button's gain step shows here too.
  useEffect(() => setDraft((current) => levelsDraft(known, current)), [known]);
  const unsaved = levelsUnsaved(draft);
  // Saving can restart the device, which waits while an update runs.
  const held = updateLock(getSetAudioUrl());
  useUnsavedChanges(unsaved, { name: 'the input levels', pending: saving });
  const { input_lines: lines, input_gain_max, adc_atten_max_db } = known.capabilities;
  const edit = (level: Level) => (value: number | null) => {
    if (value !== null) setDraft((current) => editLevel(current, level, value));
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHead
          title="Input"
          description={
            unsaved
              ? 'Shows the saved levels. Yours apply when you save them.'
              : 'What the device hears with these levels.'
          }
        >
          <Link href="/audio/calibrate" className={buttonClass()}>
            Calibrate
          </Link>
        </CardHead>
        <CardBody>
          <InputMeter />
        </CardBody>
      </Card>
      <Card>
        <CardHead
          title="Levels"
          description="Attenuation lowers the input before it is captured, so loud material stays under the clipping mark."
        />
        <CardBody>
          <Form onSubmit={() => save.mutateAsync().catch(() => undefined)}>
            {lines.length > 1 && (
              <Select
                label="Input line"
                width={64}
                choices={lines.map((entry) => ({ value: String(entry.line), label: entry.label }))}
                value={String(draft.input_line.value)}
                disabled={saving}
                onValueChange={(next) => edit('input_line')(Number(next))}
              />
            )}
            <NumberField
              label="Gain"
              width={32}
              min={0}
              max={input_gain_max}
              step={1}
              largeStep={10}
              value={draft.input_gain.value}
              disabled={saving}
              onValueChange={edit('input_gain')}
            />
            <NumberField
              label="Attenuation"
              width={32}
              unit="dB"
              min={0}
              max={adc_atten_max_db}
              step={1}
              largeStep={3}
              value={draft.adc_attenuation_db.value}
              disabled={saving}
              onValueChange={edit('adc_attenuation_db')}
            />
            {save.error && (
              <WriteFailure
                className="mt-3"
                failed="The device did not save the levels."
                error={save.error}
              />
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {held && <p className="mr-auto text-sm text-text-secondary">{held}</p>}
              <Button
                disabled={!unsaved || saving}
                onClick={() => setDraft((current) => discardLevels(current))}
              >
                Discard changes
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={saving}
                disabled={!unsaved || held !== null}
              >
                Save
              </Button>
            </div>
          </Form>
        </CardBody>
      </Card>
    </div>
  );
}
