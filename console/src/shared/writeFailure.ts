/**
 * What a failed write tells the owner. One the server refused did not
 * happen; one it left unanswered may have happened all the same, so the
 * owner checks first; one the console never sent says why.
 */

import { createContext, useContext } from 'react';
import { errorMessage } from './errors';
import { ApiError, type Peer, UnansweredError } from './http';

export interface WriteFailureWords {
  tone: 'danger' | 'warn';
  title: string;
  description: string;
}

/** The server a console writes to, which its App names once for every failure it words. */
export const PeerContext = createContext<Peer | null>(null);

export function usePeer(): Peer {
  const peer = useContext(PeerContext);
  if (peer === null) throw new Error('a console names its server with PeerContext');
  return peer;
}

/** `failed` says what a refusal means, such as "The device did not save the levels." */
export function writeFailure(error: unknown, failed: string, peer: Peer): WriteFailureWords {
  if (error instanceof ApiError) {
    return { tone: 'danger', title: failed, description: error.message };
  }
  // A dropped connection may have carried the write before it dropped.
  if (error instanceof UnansweredError || error instanceof TypeError) {
    return {
      tone: 'warn',
      title: `The ${peer} did not answer.`,
      description: 'The change may have been made anyway, so check before trying again.',
    };
  }
  return { tone: 'danger', title: failed, description: errorMessage(error) };
}
