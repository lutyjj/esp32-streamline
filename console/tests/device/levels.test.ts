import { describe, expect, it } from 'vitest';
import type { StatusResponse } from '../../src/device/lib/api';
import { edited, followed, seeded, unsaved } from '../../src/device/lib/follow';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  discardLevels,
  editLevel,
  levelsDraft,
  levelsUnsaved,
  profileCaptureBlock,
} from '../../src/device/state/levels';

function withAudio(audio: Partial<StatusResponse['audio']>): StatusResponse {
  const status = deviceStatus();
  return { ...status, audio: { ...status.audio, ...audio } };
}

describe('a followed field', () => {
  it('follows the device while untouched, and counts each move for a cue', () => {
    const moved = followed(seeded(10), 12);
    expect(moved).toEqual({ value: 12, applied: 12, moved: 1 });
    expect(followed(moved, 12)).toBe(moved);
  });

  it('keeps the owner’s value and measures it against what the device holds now', () => {
    const typed = edited(seeded(10), 15);
    const underneath = followed(typed, 12);
    expect(underneath).toEqual({ value: 15, applied: 12, moved: 0 });
    expect(unsaved(underneath)).toBe(true);
    // The device arriving at the owner's value leaves nothing unsaved.
    expect(unsaved(followed(underneath, 15))).toBe(false);
  });

  it('follows again once the owner puts the device’s value back', () => {
    const back = edited(edited(seeded(10), 15), 10);
    expect(followed(back, 11)).toMatchObject({ value: 11, moved: 1 });
  });
});

describe('the levels draft', () => {
  it('takes a button’s gain step while the owner edits the attenuation', () => {
    let draft = levelsDraft(withAudio({ input_gain: 20, adc_attenuation_db: 0 }));
    draft = editLevel(draft, 'adc_attenuation_db', 6);
    draft = levelsDraft(withAudio({ input_gain: 30, adc_attenuation_db: 0 }), draft);
    expect(draft.input_gain.value).toBe(30);
    expect(draft.adc_attenuation_db.value).toBe(6);
    expect(levelsUnsaved(draft)).toBe(true);
  });

  it('holds profiles back until the draft is saved or discarded', () => {
    const draft = editLevel(levelsDraft(withAudio({ input_gain: 20 })), 'input_gain', 24);
    expect(profileCaptureBlock(draft)).toContain('Save or discard');
    const discarded = discardLevels(draft);
    expect(discarded.input_gain.value).toBe(20);
    expect(profileCaptureBlock(discarded)).toBeNull();
  });
});
