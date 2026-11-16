import { Notice } from 'linen';
import { errorMessage } from '../../shared/errors';
import { ApiError } from '../../shared/http';

/** What a write the device left unanswered may have done. */
export const UNANSWERED = {
  title: 'The device did not answer.',
  description: 'The change may have been made anyway, so check before trying again.',
};

/**
 * A write that failed. One the device refused did not happen; one it left
 * unanswered may have happened all the same, so the owner checks first.
 */
export function WriteFailure({
  failed,
  error,
  className,
}: {
  /** What a refusal means, such as "The device did not save the levels." */
  failed: string;
  error: unknown;
  className?: string;
}) {
  return error instanceof ApiError ? (
    <Notice className={className} tone="danger" title={failed} description={errorMessage(error)} />
  ) : (
    <Notice className={className} tone="warn" {...UNANSWERED} />
  );
}
