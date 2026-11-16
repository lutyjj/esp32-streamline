import { Button } from './Button';
import { Notice } from './Notice';

/**
 * The retry affordance the bridge console renders when something failed to
 * load: what failed, the reason, and a retry.
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
