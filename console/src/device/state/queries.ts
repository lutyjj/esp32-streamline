/** The device reads screens share, held in the shared query cache. */

import { queryOptions } from '@tanstack/preact-query';
import { getAudioProfiles, getBoards, getSettings } from '../../generated/api';

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

/** The boards this firmware knows and the one the device runs as. */
export const boardsQuery = queryOptions({
  queryKey: ['boards'],
  queryFn: () => getBoards(),
});
