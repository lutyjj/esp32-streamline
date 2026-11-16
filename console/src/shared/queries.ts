/**
 * The query cache a console's reads share, everything but a hand-written
 * poll: the client, how a dropped read is read again, and reading after a
 * write.
 */

import { QueryClient, type QueryExecuteOptions, type QueryKey } from '@tanstack/preact-query';

/** Reads a read the server dropped gets in all before it reports the failure. */
export const READ_ATTEMPTS = 4;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A device's setup network reaches no internet, which a browser may call offline.
      networkMode: 'always',
      // What the server holds changes through writes and restarts, which read it again.
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
      // A dropped connection is read again; an unanswered or refused read is final.
      retry: (failures, error) => failures < READ_ATTEMPTS - 1 && error instanceof TypeError,
      retryDelay: 1000,
    },
    mutations: { networkMode: 'always' },
  },
});

/**
 * Read `query` again now, whether or not a screen shows it, after a write
 * that changed it. A failed read keeps the last answer and records its
 * error; the write stands either way.
 */
export async function readAgain<T, K extends QueryKey>(
  query: QueryExecuteOptions<T, Error, T, T, K>,
): Promise<void> {
  await queryClient.query({ ...query, staleTime: 0 }).catch(() => undefined);
}
