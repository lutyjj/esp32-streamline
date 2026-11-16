import { ConfirmDialog } from 'linen';
import { useState } from 'react';
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
 * A confirmation whose act is a device write. It waits for the answer,
 * closes once the write is done or the unlock declined, and keeps a failure
 * in view for another try or a way out.
 */
export function WriteConfirm({ onOpenChange, failed, write, ...dialog }: WriteConfirmProps) {
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  return (
    <ConfirmDialog
      {...dialog}
      onOpenChange={(open) => {
        setFailure(null);
        onOpenChange(open);
      }}
      onConfirm={async () => {
        setFailure(null);
        try {
          await write();
          onOpenChange(false);
        } catch (error) {
          setFailure({ error });
        }
      }}
    >
      {failure && <WriteFailure failed={failed} error={failure.error} />}
    </ConfirmDialog>
  );
}
