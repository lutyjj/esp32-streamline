/**
 * What a failed write tells the owner. One the device refused did not
 * happen; one it left unanswered may have happened all the same, so the
 * owner checks first; one the console never sent says why.
 */

import { errorMessage } from '../../shared/errors';
import { ApiError } from '../../shared/http';
import { UnansweredError } from '../lib/http';

export interface WriteFailureWords {
  tone: 'danger' | 'warn';
  title: string;
  description: string;
}

/** `failed` says what a refusal means, such as "The device did not save the levels." */
export function writeFailure(error: unknown, failed: string): WriteFailureWords {
  if (error instanceof ApiError) {
    return { tone: 'danger', title: failed, description: error.message };
  }
  // A dropped connection may have carried the write before it dropped.
  if (error instanceof UnansweredError || error instanceof TypeError) {
    return {
      tone: 'warn',
      title: 'The device did not answer.',
      description: 'The change may have been made anyway, so check before trying again.',
    };
  }
  return { tone: 'danger', title: failed, description: errorMessage(error) };
}
