import { Notice } from 'linen';
import { usePeer, writeFailure } from './writeFailure';

/**
 * A write that failed, in the words `writeFailure` gives it: refused, left
 * unanswered, or never sent.
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
  return <Notice className={className} {...writeFailure(error, failed, usePeer())} />;
}
