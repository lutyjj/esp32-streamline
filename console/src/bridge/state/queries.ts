/** The bridge reads screens share, held in the shared query cache. */

import { queryOptions } from '@tanstack/preact-query';
import { getBridgeStatus, getRecordingCapabilities, getRecordings } from '../../generated/bridge';

/** How often the live readings are read. */
export const STATUS_EVERY_MS = 1_000;

/** Sources, their levels and reception, audio security and Music Assistant, read every second. */
export const statusQuery = queryOptions({
  queryKey: ['status'],
  queryFn: () => getBridgeStatus(),
  refetchInterval: STATUS_EVERY_MS,
  // The next read comes within a second; a failed one says the bridge is away.
  retry: false,
});

/** Whether the deployment records, in what format, within what limits. */
export const capabilitiesQuery = queryOptions({
  queryKey: ['recording-capabilities'],
  queryFn: () => getRecordingCapabilities(),
});

/** Sessions and saved files, which need the token; read every second while one runs. */
export const recordingsQuery = queryOptions({
  queryKey: ['recordings'],
  queryFn: () => getRecordings(),
  refetchInterval: (query) => (query.state.data?.active.length ? STATUS_EVERY_MS : false),
});
