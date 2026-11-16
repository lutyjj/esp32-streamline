import type { UseQueryResult } from '@tanstack/preact-query';
import { Button, Notice } from 'linen';
import { errorMessage } from '../../shared/errors';

/** Says that a read never loaded, with a retry beside it. Nothing while it loads or once it has. */
export function ReadNotice({ read, name }: { read: UseQueryResult<unknown>; name: string }) {
  if (!read.isError || read.data !== undefined) return null;
  return (
    <Notice
      tone="danger"
      title={`The ${name} did not load.`}
      description={errorMessage(read.error)}
      action={
        <Button busy={read.isFetching} onClick={() => void read.refetch()}>
          Try again
        </Button>
      }
    />
  );
}
