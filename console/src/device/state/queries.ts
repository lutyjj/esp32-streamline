/**
 * Device reads held in the query cache, everything but the status poll: the
 * client, how a dropped read is read again, and the reads screens share.
 */

import {
  type FetchQueryOptions,
  QueryClient,
  type QueryKey,
  queryOptions,
} from '@tanstack/preact-query';
import { getAudioProfiles, getSettings } from '../../generated/api';

/** Reads a read the device dropped gets in all before it reports the failure. */
export const READ_ATTEMPTS = 4;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The setup network reaches no internet, which a browser may call offline.
      networkMode: 'always',
      // What the device holds changes through writes and restarts, which read it again.
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
      // A dropped connection is read again; an unanswered or refused read is final.
      retry: (failures, error) => failures < READ_ATTEMPTS - 1 && error instanceof TypeError,
      retryDelay: 1000,
    },
    mutations: { networkMode: 'always' },
  },
});

/** The device's stored settings; forms copy them into their own drafts. */
export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => getSettings(),
});

/** The named audio profiles, stored apart from the settings. */
export const audioProfilesQuery = queryOptions({
  queryKey: ['audio-profiles'],
  queryFn: () => getAudioProfiles(),
});

/**
 * Read `query` again now, whether or not a screen shows it, after a write
 * that changed it. A failed read keeps the last answer and records its
 * error; the write stands either way.
 */
export async function readAgain<T, K extends QueryKey>(
  query: FetchQueryOptions<T, Error, T, K>,
): Promise<void> {
  await queryClient.fetchQuery({ ...query, staleTime: 0 }).catch(() => undefined);
}
