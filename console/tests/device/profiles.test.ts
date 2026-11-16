import { describe, expect, it } from 'vitest';
import {
  addProfile,
  exportAudioProfileCatalog,
  nextProfileId,
  profileFromAudio,
  removeProfile,
  updateProfile,
} from '../../src/device/lib/profiles';
import type { AudioProfileCatalog, SettingsResponse } from '../../src/generated/api';

const config: SettingsResponse = {
  device_name: '',
  ssid: 'home',
  open_network: false,
  target_host: '',
  target_port: 39000,
  transport: {
    contract_version: 1,
    mode: 'cleartext',
    active_key_id: null,
    pending_key_id: null,
    pending_verified: false,
    rollback_key_id: null,
  },
  auto_update_schedule: 'daily',
  input_line: 2,
  input_gain: 7,
  adc_attenuation_db: 12,
  analog_passthrough_enabled: false,
  led_roles: [],
  button_actions: [],
  config_source: 'nvs',
};

describe('audio profile model', () => {
  it('creates stable unique ids from display names', () => {
    expect(nextProfileId('Vinyl / Phono', [])).toBe('vinyl-phono');
    expect(nextProfileId('Vinyl', ['vinyl', 'vinyl-2'])).toBe('vinyl-3');
    expect(nextProfileId('レコード', [])).toBe('profile');
  });

  it('shortens an id to the length the contract allows, before any number', () => {
    expect(nextProfileId('A'.repeat(40), [])).toBe('a'.repeat(32));
    expect(nextProfileId('A'.repeat(40), ['a'.repeat(32)])).toBe(`${'a'.repeat(30)}-2`);
    // A cut that ends on a separator drops it.
    expect(nextProfileId(`${'x'.repeat(31)} y`, [])).toBe('x'.repeat(31));
  });

  it('snapshots the applied device settings', () => {
    expect(profileFromAudio('vinyl', 'Vinyl', config)).toEqual({
      id: 'vinyl',
      name: 'Vinyl',
      audio: { input_line: 2, input_gain: 7, adc_attenuation_db: 12 },
    });
  });

  it('exports definitions without transferring active device state', () => {
    const catalog: AudioProfileCatalog = {
      schema_version: 1,
      board_id: 'board-a',
      active_profile_id: 'vinyl',
      profiles: [profileFromAudio('vinyl', 'Vinyl', config)],
    };
    expect(JSON.parse(exportAudioProfileCatalog(catalog)).active_profile_id).toBeNull();
  });
});

// The device checks every catalog it is sent; these edits only shape the change.
describe('audio profile edits', () => {
  const empty: AudioProfileCatalog = {
    schema_version: 1,
    board_id: 'board-a',
    active_profile_id: null,
    profiles: [],
  };

  it('adds a profile that snapshots the applied settings and yields its id', () => {
    const { catalog, id } = addProfile(empty, ' Vinyl ', config);
    expect(id).toBe('vinyl');
    expect(catalog.profiles).toEqual([
      {
        id: 'vinyl',
        name: 'Vinyl',
        audio: { input_line: 2, input_gain: 7, adc_attenuation_db: 12 },
      },
    ]);
    // Pure: the source catalog is never mutated in place.
    expect(empty.profiles).toHaveLength(0);
  });

  it('re-snapshots the selected profile from the current applied settings', () => {
    const seeded = addProfile(empty, 'Vinyl', config).catalog;
    const louder: SettingsResponse = { ...config, adc_attenuation_db: 24 };
    const next = updateProfile(seeded, 'vinyl', ' Vinyl HD ', louder);
    expect(next.profiles).toEqual([
      {
        id: 'vinyl',
        name: 'Vinyl HD',
        audio: { input_line: 2, input_gain: 7, adc_attenuation_db: 24 },
      },
    ]);
  });

  it('deletes a profile and clears the active pointer only when it named it', () => {
    const two: AudioProfileCatalog = {
      ...empty,
      active_profile_id: 'vinyl',
      profiles: [profileFromAudio('vinyl', 'Vinyl', config), profileFromAudio('cd', 'CD', config)],
    };
    const afterActive = removeProfile(two, 'vinyl');
    expect(afterActive.profiles.map((p) => p.id)).toEqual(['cd']);
    expect(afterActive.active_profile_id).toBeNull();

    const afterOther = removeProfile(two, 'cd');
    expect(afterOther.active_profile_id).toBe('vinyl');
  });
});
