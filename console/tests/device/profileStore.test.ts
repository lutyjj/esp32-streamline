import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setAudio, setTransport } from '../../src/device/lib/api';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import {
  audioProfiles,
  loadAudioProfiles,
  loadContract,
  refresh,
} from '../../src/device/state/device';
import {
  deleteProfile,
  exportProfiles,
  importProfiles,
  renameProfile,
  replaceProfile,
  saveProfile,
} from '../../src/device/state/profiles';
import { answering } from './answering';

beforeEach(async () => {
  const device = new FakeDevice('steady');
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  unlockSettings(MOCK_ADMIN_KEY, false);
  await Promise.all([refresh(), loadAudioProfiles(), loadContract()]);
});

afterEach(() => {
  forgetAdminKey();
  answering(null);
  setTransport((request) => fetch(request));
});

const names = () => audioProfiles.value?.profiles.map((profile) => profile.name);

describe('profile operations', () => {
  it('keep the applied levels and never select what they save', async () => {
    await expect(saveProfile('Turntable')).resolves.toBe(true);
    const [saved] = audioProfiles.value?.profiles ?? [];
    expect(saved?.name).toBe('Turntable');
    expect(audioProfiles.value?.active_profile_id).toBeNull();

    await setAudio({
      input_line: saved?.audio.input_line ?? 1,
      input_gain: 40,
      adc_attenuation_db: 0,
    });
    await refresh();
    await replaceProfile(saved?.id ?? '');
    expect(audioProfiles.value?.profiles[0]?.audio.input_gain).toBe(40);
  });

  it('rename and remove by id', async () => {
    await saveProfile('Turntable');
    const id = audioProfiles.value?.profiles[0]?.id ?? '';
    await renameProfile(id, 'Deck');
    expect(names()).toEqual(['Deck']);
    await deleteProfile(id);
    expect(names()).toEqual([]);
  });

  it('import what export wrote, and refuse what does not fit, with the reason', async () => {
    await saveProfile('Turntable');
    const exported = exportProfiles();
    await deleteProfile(audioProfiles.value?.profiles[0]?.id ?? '');
    await importProfiles(exported);
    expect(names()).toEqual(['Turntable']);
    await expect(importProfiles('{"not":"a catalog"}')).rejects.toThrow();
    expect(names()).toEqual(['Turntable']);
  });
});
