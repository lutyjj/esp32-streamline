import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { refresh } from '../../src/device/state/device';
import {
  deleteProfile,
  exportProfiles,
  importProfiles,
  renameProfile,
  replaceProfile,
  saveProfile,
} from '../../src/device/state/profiles';
import { audioProfilesQuery, queryClient } from '../../src/device/state/queries';
import { setAudio } from '../../src/generated/api';
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
  queryClient.clear();
  await Promise.all([refresh(), queryClient.fetchQuery(audioProfilesQuery)]);
});

afterEach(() => {
  forgetAdminKey();
  answering(null);
  setTransport((request) => fetch(request));
});

const catalog = () => queryClient.getQueryData(audioProfilesQuery.queryKey);
const names = () => catalog()?.profiles.map((profile) => profile.name);

describe('profile operations', () => {
  it('keep the applied levels and never select what they save', async () => {
    await expect(saveProfile('Turntable')).resolves.toBe(true);
    const [saved] = catalog()?.profiles ?? [];
    expect(saved?.name).toBe('Turntable');
    expect(catalog()?.active_profile_id).toBeNull();

    await setAudio({
      input_line: saved?.audio.input_line ?? 1,
      input_gain: 40,
      adc_attenuation_db: 0,
    });
    await refresh();
    await replaceProfile(saved?.id ?? '');
    expect(catalog()?.profiles[0]?.audio.input_gain).toBe(40);
  });

  it('rename and remove by id', async () => {
    await saveProfile('Turntable');
    const id = catalog()?.profiles[0]?.id ?? '';
    await renameProfile(id, 'Deck');
    expect(names()).toEqual(['Deck']);
    await deleteProfile(id);
    expect(names()).toEqual([]);
  });

  it('import what export wrote, and refuse what does not fit, with the reason', async () => {
    await saveProfile('Turntable');
    const exported = exportProfiles();
    await deleteProfile(catalog()?.profiles[0]?.id ?? '');
    await importProfiles(exported);
    expect(names()).toEqual(['Turntable']);
    await expect(importProfiles('{"not":"a catalog"}')).rejects.toMatchObject({
      field: 'catalog',
    });
    const otherBoard = JSON.stringify({ ...JSON.parse(exported), board_id: 'another-board' });
    await expect(importProfiles(otherBoard)).rejects.toThrow(
      'These profiles are for another board.',
    );
    expect(names()).toEqual(['Turntable']);
  });

  it('pass on the reason the device refuses a name', async () => {
    await expect(saveProfile('x'.repeat(40))).rejects.toMatchObject({ field: 'catalog' });
    expect(names()).toEqual([]);
  });
});
