import { useMutation } from '@tanstack/preact-query';
import { ConfirmDialog } from 'linen';
import { queryClient } from './queries';
import { WriteFailure } from './WriteFailure';

interface WriteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  /** What a refusal means, such as "The device did not restart." */
  failed: string;
  /** The confirmed write. It settles once the device has answered, or the unlock was declined. */
  write: () => Promise<unknown>;
}

/**
 * A confirmation whose act is a write to the server. It waits for the answer,
 * closes once the write is done or the unlock declined, and keeps a failure
 * in view for another try or a way out.
 */
export function WriteConfirm({ onOpenChange, failed, write, ...dialog }: WriteConfirmProps) {
  const run = useMutation(
    { mutationFn: () => write(), onSuccess: () => onOpenChange(false) },
    queryClient,
  );
  return (
    <ConfirmDialog
      {...dialog}
      onOpenChange={(open) => {
        run.reset();
        onOpenChange(open);
      }}
      onConfirm={() => run.mutateAsync().catch(() => undefined)}
    >
      {run.error && <WriteFailure failed={failed} error={run.error} />}
    </ConfirmDialog>
  );
}
