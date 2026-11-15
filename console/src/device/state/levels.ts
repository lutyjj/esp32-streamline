/**
 * The input levels draft: input line, gain and attenuation, saved together.
 * Each field follows the device until the owner changes it, so a button that
 * steps the gain shows up while the owner edits the attenuation. The meter
 * keeps describing the applied levels until a save lands.
 */

import { type AudioSettings, type StatusResponse, setAudio } from '../lib/api';
import { discarded, edited, type Followed, followed, seeded, unsaved } from '../lib/follow';
import { withAccess } from './access';

export type Level = keyof AudioSettings;

export type LevelsDraft = Record<Level, Followed<number>>;

const LEVELS: readonly Level[] = ['input_line', 'input_gain', 'adc_attenuation_db'];

function applied(status: StatusResponse): AudioSettings {
  const { input_line, input_gain, adc_attenuation_db } = status.audio;
  return { input_line, input_gain, adc_attenuation_db };
}

/** The draft as the device last reported, or as it follows a new report. */
export function levelsDraft(status: StatusResponse, draft?: LevelsDraft): LevelsDraft {
  const live = applied(status);
  const next = {} as LevelsDraft;
  for (const level of LEVELS) {
    next[level] = draft ? followed(draft[level], live[level]) : seeded(live[level]);
  }
  return next;
}

export function editLevel(draft: LevelsDraft, level: Level, value: number): LevelsDraft {
  return { ...draft, [level]: edited(draft[level], value) };
}

export function levelsUnsaved(draft: LevelsDraft): boolean {
  return LEVELS.some((level) => unsaved(draft[level]));
}

export function discardLevels(draft: LevelsDraft): LevelsDraft {
  const next = {} as LevelsDraft;
  for (const level of LEVELS) next[level] = discarded(draft[level]);
  return next;
}

/**
 * Save the draft's values. Resolves false when the owner declines to unlock;
 * the draft then stays as it is, and the next read shows the saved values.
 */
export async function saveLevels(draft: LevelsDraft): Promise<boolean> {
  const audio: AudioSettings = {
    input_line: draft.input_line.value,
    input_gain: draft.input_gain.value,
    adc_attenuation_db: draft.adc_attenuation_db.value,
  };
  return (await withAccess(() => setAudio(audio))) !== null;
}

/** Why a profile cannot be saved from the levels right now, or null. */
export function profileCaptureBlock(draft: LevelsDraft): string | null {
  return levelsUnsaved(draft)
    ? 'Save or discard the level changes first: a profile keeps the applied levels.'
    : null;
}
