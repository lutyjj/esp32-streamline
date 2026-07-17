import type { Resource } from '../lib/resource';
import { Button } from './Button';
import { Notice } from './Notice';

/**
 * The one retry affordance for a resource that failed before it ever loaded.
 * Renders nothing while the resource is loading or has data to show.
 */
export function ResourceNotice({ of }: { of: Resource<unknown> }) {
  if (of.state.value !== 'error') return null;
  return (
    <Notice tone="error">
      Couldn’t load {of.name} — {of.error.value || 'the request failed'}.{' '}
      <Button onClick={() => void of.load()}>Retry</Button>
    </Notice>
  );
}
