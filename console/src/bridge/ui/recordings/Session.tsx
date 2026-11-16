import { useMutation } from '@tanstack/preact-query';
import { Button, Card, CardBody, CardHead, Fact, Facts, Status, useToast } from 'linen';
import type { RecordingSnapshot } from '../../../generated/bridge';
import { bytes, duration } from '../../../shared/format';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { stopAndSave } from '../../state/recordings';

const STATE_WORDS: Partial<Record<RecordingSnapshot['state'], { label: string; meaning: string }>> =
  {
    'waiting-for-audio': {
      label: 'Waiting for audio',
      meaning: 'Play the source. The file starts with the first audio the bridge receives.',
    },
    recording: { label: 'Recording', meaning: 'Stop and save when the passage has ended.' },
    finalizing: { label: 'Saving', meaning: 'The bridge is finishing the file.' },
  };

/** A recording under way: what it has captured, the room left, and the way to end it. */
export function Session({ session, room }: { session: RecordingSnapshot; room: number }) {
  const toast = useToast();
  const stop = useMutation(
    {
      mutationFn: () => stopAndSave(session.id),
      onSuccess: (result) => {
        if (!result) return;
        toast.show({
          text:
            result.recording.state === 'empty'
              ? `“${session.title}” received no audio, so no file was made.`
              : `“${session.title}” is saved.`,
        });
      },
    },
    queryClient,
  );
  const words = STATE_WORDS[session.state];
  return (
    <Card>
      <CardHead
        title={session.title}
        aside={
          <Status tone="accent" active>
            {words?.label ?? session.state}
          </Status>
        }
        description={words?.meaning}
      >
        <Button variant="primary" busy={stop.isPending} onClick={() => stop.mutate()}>
          Stop and save
        </Button>
      </CardHead>
      <CardBody>
        {stop.error && <WriteFailure failed="The recording goes on." error={stop.error} />}
        <Facts>
          <Fact name="Source" mono>
            {session.source}
          </Fact>
          <Fact name="Length">{duration(session.duration_seconds)}</Fact>
          <Fact name="Size">{bytes(session.bytes)}</Fact>
          <Fact name="Gaps">
            {session.gap_packets ? `${session.gap_packets} packets filled with silence` : 'None'}
          </Fact>
          <Fact name="Room left">About {duration(room)}</Fact>
        </Facts>
      </CardBody>
    </Card>
  );
}
