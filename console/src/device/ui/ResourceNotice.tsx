import { Button, Notice } from 'linen';
import { useState } from 'react';
import type { Resource } from '../../shared/resource';

/** Says that a resource never loaded, with a retry beside it. Nothing while it loads or loaded. */
export function ResourceNotice({ resource }: { resource: Resource<unknown> }) {
  const [retrying, setRetrying] = useState(false);
  if (resource.state.value !== 'error') return null;
  return (
    <Notice
      tone="danger"
      title={`The ${resource.name} did not load.`}
      description={resource.error.value}
      action={
        <Button
          busy={retrying}
          onClick={() => {
            setRetrying(true);
            void resource.load().finally(() => setRetrying(false));
          }}
        >
          Try again
        </Button>
      }
    />
  );
}
