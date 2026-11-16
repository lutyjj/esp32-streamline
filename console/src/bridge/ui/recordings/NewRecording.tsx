import { useMutation } from '@tanstack/preact-query';
import { Button, Card, CardBody, CardHead, Form, Select, TextField } from 'linen';
import { useState } from 'react';
import type { BridgeStatus } from '../../../generated/bridge';
import { duration } from '../../../shared/format';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { record, titleProblem } from '../../state/recordings';

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
  const chosen = sources.includes(source) ? source : (sources[0] ?? '');
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
      <CardBody>
        {sources.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No source to record. A device appears under Sources while it streams to this bridge.
          </p>
        ) : (
          <Form errors={errors} onSubmit={() => start.mutateAsync().catch(() => undefined)}>
            <Select
              label="Source"
              width={64}
              name="source"
              value={chosen}
              onValueChange={setSource}
              choices={sources.map((id) => ({ value: id, label: id }))}
            />
            <TextField
              label="Title"
              width={96}
              name="title"
              value={title}
              validate={(value) => titleProblem(String(value ?? '').trim(), limit)}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            {start.error && Object.keys(errors).length === 0 && (
              <WriteFailure failed="The recording did not start." error={start.error} />
            )}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={title.trim() === ''}>
                Start recording
              </Button>
            </div>
          </Form>
        )}
      </CardBody>
    </Card>
  );
}
