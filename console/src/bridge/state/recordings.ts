/** Recording writes, the download, and how much recording the storage has room for. */

import * as v from 'valibot';
import {
  createRecordingDownloadTicket,
  deleteRecording,
  type RecordingCapabilities,
  type RecordingList,
  startRecording,
  stopRecording,
} from '../../generated/bridge';
import { StartRecordingRequest } from '../../generated/bridgeRules';
import { readAgain } from '../../shared/queries';
import { withToken } from './access';
import { recordingsQuery } from './queries';

async function changeRecordings<T>(write: () => Promise<T>): Promise<T | null> {
  const done = await withToken(write);
  if (done !== null) await readAgain(recordingsQuery);
  return done;
}

export function record(source: string, title: string) {
  return changeRecordings(() => startRecording({ source, title }));
}

export function stopAndSave(id: string) {
  return changeRecordings(() => stopRecording(id));
}

export function remove(id: string) {
  return changeRecordings(() => deleteRecording(id));
}

/**
 * Hand a saved recording to the browser's own download. A one-use ticket
 * stands in for the token, so the file streams without passing through the
 * page; its address is the bridge's, under the page's own prefix.
 */
export async function download(id: string): Promise<boolean> {
  const ticket = await withToken(() => createRecordingDownloadTicket(id));
  if (ticket === null) return false;
  const link = document.createElement('a');
  link.href = new URL(`.${ticket.url}`, document.baseURI).toString();
  link.download = '';
  link.click();
  return true;
}

/**
 * Seconds of audio the storage takes before the bridge stops a recording
 * for want of room: what lies above its floor, at the recording's rate.
 */
export function recordingRoom(list: RecordingList, capabilities: RecordingCapabilities): number {
  const spare = list.storage.free_bytes - capabilities.limits.min_free_bytes;
  return Math.max(0, spare) / capabilities.format.bytes_per_second;
}

const titleRule = StartRecordingRequest.entries.title;

/**
 * Why the contract refuses `value` as a title, or null; `limit` is the
 * bridge's own. The bridge collapses whitespace, so a blank title is none.
 */
export function titleProblem(value: string, limit: number): string | null {
  return v.is(titleRule, value.trim())
    ? null
    : `Name the recording, in at most ${limit} characters.`;
}

/**
 * The source a new recording takes: the one chosen, or the first known while
 * none is. A chosen source that stops streaming is gone, never replaced.
 */
export function recordingSource(
  chosen: string,
  available: readonly string[],
): { source: string; gone: boolean } {
  if (chosen === '') return { source: available[0] ?? '', gone: false };
  return { source: chosen, gone: !available.includes(chosen) };
}
