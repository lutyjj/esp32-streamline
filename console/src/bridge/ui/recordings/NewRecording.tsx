import { useMutation } from '@tanstack/preact-query';
import { Actions, Button, Card, CardBody, CardHead, Form, Select, TextField } from 'linen';
import { useEffect, useMemo, useState } from 'react';
import type { BridgeStatus } from '../../../generated/bridge';
import { duration } from '../../../shared/format';
import { FIELD_WIDTH } from '../../../shared/fieldWidth';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { record, recordingSource, titleProblem } from '../../state/recordings';

/** A new recording of a source the bridge knows, which no session holds. */
export function NewRecording({
  known,
  busy,
  limit,
  room,
  onStarted,
}: {
  known: BridgeStatus | undefined;
  /** The sources a session already records. */
  busy: readonly string[];
  limit: number;
  /** Seconds of audio the storage has room for. */
  room: number;
  onStarted: () => void;
}) {
  const sources = Object.keys(known?.sources ?? {})
    .filter((id) => !busy.includes(id))
    .sort();
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const first = sources[0];
  // The first source shown is held as chosen, so it never gives way to another unasked.
  useEffect(() => {
    if (source === '' && first !== undefined) setSource(first);
  }, [source, first]);
  const { source: chosen, gone } = recordingSource(source, sources);
  // A source that stopped streaming stays chosen and says so, rather than giving way to another.
  const shown = useMemo(
    () =>
      gone
        ? { ...errors, source: 'This source is no longer available to record. Choose another.' }
        : errors,
    [gone, errors],
  );
  const start = useMutation(
    {
      mutationFn: () => record(chosen, title.trim()),
      onSuccess: (started) => {
        setErrors({});
        if (!started) return;
        setTitle('');
        onStarted();
      },
      onError: (error) => setErrors(fieldErrors(error, ['source', 'title'])),
    },
    queryClient,
  );
  return (
    <Card>
      <CardHead
        title="New recording"
        description={`Start before the passage you want: the file begins with the first audio the bridge receives. The storage holds about ${duration(room)} more.`}
      />
      {sources.length === 0 ? (
        <CardBody>
          <p className="text-sm text-text-secondary">
            No source to record. A device appears under Sources while it streams to this bridge.
          </p>
        </CardBody>
      ) : (
        <Form errors={shown} onSubmit={() => start.mutateAsync().catch(() => undefined)}>
          <CardBody>
            <Select
              label="Source"
              width={FIELD_WIDTH}
              name="source"
              value={chosen}
              onValueChange={setSource}
              choices={(gone ? [...sources, chosen] : sources).map((id) => ({
                value: id,
                label: id,
                disabled: gone && id === chosen,
              }))}
            />
            <TextField
              label="Title"
              width={FIELD_WIDTH}
              name="title"
              value={title}
              validate={(value) => titleProblem(String(value ?? ''), limit)}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            {start.error && Object.keys(errors).length === 0 && (
              <WriteFailure failed="The recording did not start." error={start.error} />
            )}
            <Actions className="justify-end">
              <Button type="submit" variant="primary" disabled={title.trim() === '' || gone}>
                Start recording
              </Button>
            </Actions>
          </CardBody>
        </Form>
      )}
    </Card>
  );
}
