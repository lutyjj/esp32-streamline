import type { Resource } from '../lib/resource';
import { Button } from './Button';
import { Notice } from './Notice';

/**
 * The one retry affordance both consoles render when something failed to
 * load: the resource's name, the reason, and a retry.
 */
export function LoadFailure({
  name,
  error,
  onRetry,
}: {
  name: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <Notice tone="error">
      Couldn’t load {name} — {error || 'the request failed'}.{' '}
      <Button onClick={onRetry}>Retry</Button>
    </Notice>
  );
}

/**
 * `LoadFailure` for a `Resource`: renders nothing while it is loading or has
 * data to show.
 */
export function ResourceNotice({ of }: { of: Resource<unknown> }) {
  if (of.state.value !== 'error') return null;
  return <LoadFailure name={of.name} error={of.error.value} onRetry={() => void of.load()} />;
}
