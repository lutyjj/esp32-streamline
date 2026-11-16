import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { edited, followed, seeded, unsaved } from '../../src/device/lib/follow';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { connection, status } from '../../src/device/state/device';
import {
  discardLevels,
  editLevel,
  keptLevels,
  levelsDraft,
  levelsUnsaved,
  saveLevels,
} from '../../src/device/state/levels';
import { audioProfilesQuery } from '../../src/device/state/queries';
import type { StatusResponse } from '../../src/generated/api';
import { queryClient } from '../../src/shared/queries';
import { answering } from './answering';

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

  it('puts every level back to what the device holds on discard', () => {
    const draft = editLevel(levelsDraft(withAudio({ input_gain: 20 })), 'input_gain', 24);
    const discarded = discardLevels(draft);
    expect(discarded.input_gain.value).toBe(20);
    expect(levelsUnsaved(discarded)).toBe(false);
  });
});

describe('a draft the device has taken', () => {
  it('holds nothing unsaved through the restart that applies it, then follows the device', () => {
    const before = withAudio({ input_gain: 20 });
    const kept = keptLevels(editLevel(levelsDraft(before), 'input_gain', 24));
    expect(levelsUnsaved(kept)).toBe(false);
    // A start that applied it moves nothing; one that did not shows the device's levels.
    expect(levelsDraft(withAudio({ input_gain: 24 }), kept).input_gain.value).toBe(24);
    expect(levelsDraft(withAudio({ input_gain: 30 }), kept).input_gain.value).toBe(30);
  });
});

describe('saving the levels', () => {
  let device: StatusResponse;

  beforeEach(() => {
    device = withAudio({ input_gain: 20 });
    answering(device);
    unlockSettings('a'.repeat(48), false);
  });

  afterEach(() => {
    forgetAdminKey();
    setTransport((request) => fetch(request));
  });

  it('reads the saved levels back, so the draft holds nothing unsaved', async () => {
    setTransport(async (request) => {
      if (request.method === 'GET') return Response.json(device);
      device = withAudio({ input_gain: 24 });
      return Response.json({ ok: true });
    });
    const draft = editLevel(levelsDraft(device), 'input_gain', 24);

    await expect(saveLevels(draft)).resolves.toBe(true);

    expect(status.value?.audio.input_gain).toBe(24);
    expect(levelsUnsaved(levelsDraft(status.value ?? device, draft))).toBe(false);
  });

  it('follows the restart a device without a running codec needs to apply them', async () => {
    setTransport(async () => Response.json({ ok: true, rebooting: true }));
    await saveLevels(editLevel(levelsDraft(device), 'input_gain', 24));
    expect(connection.value).toMatchObject({ phase: 'waiting', operation: 'the level change' });
  });

  it('reads the catalog again, since the device drops its active profile on a level save', async () => {
    const catalog = {
      schema_version: 1,
      board_id: device.capabilities.board_id,
      active_profile_id: 'loud',
      profiles: [{ id: 'loud', name: 'Loud', audio: device.audio }],
    };
    queryClient.setQueryData(audioProfilesQuery.queryKey, catalog);
    setTransport(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/audio-profiles')
        return Response.json({ ...catalog, active_profile_id: null });
      return request.method === 'GET' ? Response.json(device) : Response.json({ ok: true });
    });

    await saveLevels(editLevel(levelsDraft(device), 'input_gain', 24));

    expect(queryClient.getQueryData(audioProfilesQuery.queryKey)?.active_profile_id).toBeNull();
    queryClient.clear();
  });
});
