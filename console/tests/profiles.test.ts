import { describe, expect, it } from 'vitest';
import type { AudioProfileCatalog, BoardCapabilities, DeviceConfig } from '../src/lib/api';
import {
  type AudioProfileImportLimits,
  addProfile,
  exportAudioProfileCatalog,
  nextProfileId,
  parseAudioProfileCatalog,
  profileFromAudio,
  removeProfile,
  updateProfile,
} from '../src/lib/profiles';

const capabilities: BoardCapabilities = {
  board_id: 'board-a',
  board: 'Board A',
  codec: { driver: 'es8388', i2c_address: 16 },
  pins: { i2c: { sda: 1, scl: 2 }, i2s: { mclk: 3, bclk: 4, ws: 5, din: 6 } },
  leds: [],
  buttons: [],
  input_lines: [{ line: 2, label: 'Line 2' }],
  input_gain_max: 100,
  adc_atten_max_db: 48,
};

// The device declares these; the console injects them so the parser stays pure.
const limits: AudioProfileImportLimits = {
  schemaVersion: 1,
  maxProfiles: 8,
  idPattern: '^[a-z0-9][a-z0-9-]*$',
  idMinChars: 0,
  idMaxChars: 32,
  nameMaxChars: 32,
};

const config: DeviceConfig = {
  device_name: '',
  ssid: 'home',
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

const parse = (catalog: unknown) =>
  parseAudioProfileCatalog(JSON.stringify(catalog), capabilities, limits);

describe('audio profile model', () => {
  it('creates stable unique ids from display names', () => {
    expect(nextProfileId('Vinyl / Phono', [], limits)).toBe('vinyl-phono');
    expect(nextProfileId('Vinyl', ['vinyl', 'vinyl-2'], limits)).toBe('vinyl-3');
    expect(nextProfileId('レコード', [], limits)).toBe('profile');
  });

  it('uses declared id lengths for truncation, padding, and collision suffixes', () => {
    const compact = { ...limits, idMinChars: 5, idMaxChars: 8 };
    expect(nextProfileId('Long Profile Name', [], compact)).toBe('long-pro');
    expect(nextProfileId('Long Profile Name', ['long-pro'], compact)).toBe('long-p-2');
    expect(nextProfileId('CD', [], compact)).toBe('cd-pr');
    expect(nextProfileId('CD', [], { ...limits, idMinChars: 32 })).toHaveLength(32);
    expect(nextProfileId('CD', ['cd'], { ...limits, idMaxChars: 2 })).toBe('c2');
  });

  it('fails clearly when the declared id vocabulary cannot represent the slug', () => {
    expect(() =>
      nextProfileId('Vinyl', [], {
        ...limits,
        idPattern: '^[A-Z]+$',
      }),
    ).toThrow(/cannot generate/);
  });

  it('snapshots the applied device settings', () => {
    expect(profileFromAudio('vinyl', 'Vinyl', config)).toEqual({
      id: 'vinyl',
      name: 'Vinyl',
      audio: { input_line: 2, input_gain: 7, adc_attenuation_db: 12 },
    });
  });

  it('parses and canonicalizes a matching shared catalog', () => {
    const catalog = parse({
      schema_version: 1,
      board_id: 'board-a',
      active_profile_id: 'vinyl',
      profiles: [profileFromAudio('vinyl', 'Vinyl', config)],
    });

    expect(catalog.active_profile_id).toBeNull();
    expect(catalog.profiles[0].audio.adc_attenuation_db).toBe(12);
  });

  it('rejects wrong-board, duplicate, and over-capability data', () => {
    const base = {
      schema_version: 1,
      board_id: 'board-a',
      active_profile_id: null,
      profiles: [profileFromAudio('vinyl', 'Vinyl', config)],
    };
    expect(() => parse({ ...base, board_id: 'board-b' })).toThrow(/different board/);
    expect(() => parse({ ...base, profiles: [...base.profiles, ...base.profiles] })).toThrow(
      /more than once/,
    );
    expect(() =>
      parse({
        ...base,
        profiles: [{ ...base.profiles[0], audio: { ...base.profiles[0].audio, input_gain: 200 } }],
      }),
    ).toThrow(/limit/);
  });

  it('enforces the injected structural limits', () => {
    const base = {
      schema_version: limits.schemaVersion,
      board_id: 'board-a',
      active_profile_id: null,
      profiles: [profileFromAudio('vinyl', 'Vinyl', config)],
    };
    expect(() => parse({ ...base, schema_version: limits.schemaVersion + 1 })).toThrow(
      /schema_version/,
    );
    const tooMany = Array.from({ length: limits.maxProfiles + 1 }, (_, i) =>
      profileFromAudio(`profile-${i}`, 'Source', config),
    );
    expect(() => parse({ ...base, profiles: tooMany })).toThrow(/at most/);
    expect(() => parse({ ...base, profiles: [{ ...base.profiles[0], id: 'Bad_Id' }] })).toThrow(
      /invalid id/,
    );
    expect(() =>
      parseAudioProfileCatalog(JSON.stringify(base), capabilities, {
        ...limits,
        idMinChars: 'vinyl'.length + 1,
      }),
    ).toThrow(/invalid id/);
    expect(
      parseAudioProfileCatalog(
        JSON.stringify({ ...base, profiles: [{ ...base.profiles[0], id: '🎚️' }] }),
        capabilities,
        { ...limits, idPattern: '^.+$', idMinChars: 2, idMaxChars: 2 },
      ).profiles[0]?.id,
    ).toBe('🎚️');
    expect(() =>
      parse({
        ...base,
        profiles: [
          { ...base.profiles[0], audio: { ...base.profiles[0].audio, adc_attenuation_db: -1 } },
        ],
      }),
    ).toThrow(/non-negative integer/);
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

// Stage 4/5: the Audio tab saves the applied settings as named profiles and
// switches them live. These edits are the tab's rules, kept pure so success,
// validation, and the delete-the-active case are provable without a device.
describe('audio profile edits', () => {
  const empty: AudioProfileCatalog = {
    schema_version: 1,
    board_id: 'board-a',
    active_profile_id: null,
    profiles: [],
  };

  it('adds a profile that snapshots the applied settings and yields its id', () => {
    const { catalog, id } = addProfile(empty, ' Vinyl ', config, limits);
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

  it('rejects a blank name, an over-long name, and a full catalog', () => {
    expect(() => addProfile(empty, '   ', config, limits)).toThrow(/Enter a profile name/);
    const long = 'x'.repeat(limits.nameMaxChars + 1);
    expect(() => addProfile(empty, long, config, limits)).toThrow(/limited to 32 characters/);

    const full: AudioProfileCatalog = {
      ...empty,
      profiles: Array.from({ length: limits.maxProfiles }, (_, i) =>
        profileFromAudio(`p-${i}`, 'Source', config),
      ),
    };
    expect(() => addProfile(full, 'One more', config, limits)).toThrow(/up to 8 profiles/);
  });

  it('re-snapshots the selected profile from the current applied settings', () => {
    const seeded = addProfile(empty, 'Vinyl', config, limits).catalog;
    const louder: DeviceConfig = { ...config, adc_attenuation_db: 24 };
    const next = updateProfile(seeded, 'vinyl', 'Vinyl HD', louder, limits);
    expect(next.profiles).toEqual([
      {
        id: 'vinyl',
        name: 'Vinyl HD',
        audio: { input_line: 2, input_gain: 7, adc_attenuation_db: 24 },
      },
    ]);
    expect(() => updateProfile(seeded, 'vinyl', '', config, limits)).toThrow(
      /Enter a profile name/,
    );
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
