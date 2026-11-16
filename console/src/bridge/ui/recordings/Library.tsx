import { useMutation } from '@tanstack/preact-query';
import { Button, Card, CardHead, Count, Nothing, SettingRow, useToast } from 'linen';
import { useState } from 'react';
import type { RecordingSnapshot } from '../../../generated/bridge';
import { bytes, duration } from '../../../shared/format';
import { queryClient } from '../../../shared/queries';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { usePeer, writeFailure } from '../../../shared/writeFailure';
import { download, remove } from '../../state/recordings';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** What one saved file is: when it was made, how long, how big, and how it ended. */
function about(recording: RecordingSnapshot): string {
  const parts = [
    WHEN.format(new Date(recording.created_at)),
    duration(recording.duration_seconds),
    bytes(recording.bytes),
  ];
  if (recording.state === 'interrupted')
    parts.push(`stopped early${recording.error ? `: ${recording.error}` : ''}`);
  return parts.join(' · ');
}

/** The saved files: each to download for keeping, or to delete from the bridge. */
export function Library({ saved }: { saved: readonly RecordingSnapshot[] }) {
  const [deleting, setDeleting] = useState<RecordingSnapshot | null>(null);
  const toast = useToast();
  const peer = usePeer();
  const take = useMutation(
    {
      mutationFn: (id: string) => download(id),
      onError: (error) => {
        const words = writeFailure(error, 'The download did not start.', peer);
        toast.show({ text: `${words.title} ${words.description}`, sticky: true });
      },
    },
    queryClient,
  );
  return (
    <Card>
      <CardHead
        title="Saved recordings"
        aside={<Count>{saved.length}</Count>}
        description="The bridge is a working area, not a library: download what you keep."
      />
      {saved.length === 0 ? (
        <Nothing>
          No saved recordings yet. A recording appears here once it is stopped and saved.
        </Nothing>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold.
        <div role="list" aria-label="Saved recordings">
          {saved.map((recording) => (
            <SettingRow
              key={recording.id}
              role="listitem"
              title={recording.title}
              description={about(recording)}
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  busy={take.isPending && take.variables === recording.id}
                  onClick={() => take.mutate(recording.id)}
                >
                  Download
                </Button>
                <Button variant="destructive" onClick={() => setDeleting(recording)}>
                  Delete
                </Button>
              </div>
            </SettingRow>
          ))}
        </div>
      )}
      <WriteConfirm
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="This deletes the WAV file from the bridge for good. Download it first to keep a copy."
        confirmLabel="Delete"
        destructive
        failed="The recording was not deleted."
        write={() => (deleting ? remove(deleting.id) : Promise.resolve(null))}
      />
    </Card>
  );
}
