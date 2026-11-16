/**
 * The crash dump a panic leaves in flash: whether one is stored, its bytes
 * for `espcoredump.py`, and erasing it. Every read needs the admin key.
 */

import { queryOptions } from '@tanstack/preact-query';
import { type Ack, getCoredump, getCoredumpImage, postCoredumpErase } from '../../generated/api';
import { readAgain } from '../../shared/queries';
import { withAccess } from './access';

export const coredumpQuery = queryOptions({
  queryKey: ['coredump'],
  queryFn: () => getCoredump(),
});

/** The stored dump's bytes, or null when the owner declines to unlock. */
export function coredumpImage(): Promise<Blob | null> {
  return withAccess(() => getCoredumpImage());
}

export async function eraseCoredump(): Promise<Ack | null> {
  const done = await withAccess(() => postCoredumpErase());
  if (done) await readAgain(coredumpQuery);
  return done;
}
