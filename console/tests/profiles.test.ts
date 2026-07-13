import { describe, expect, it } from 'vitest';
import type { AudioProfileCatalog, BoardCapabilities, DeviceConfig } from '../src/lib/api';
import {
  type AudioProfileImportLimits,
  exportAudioProfileCatalog,
  nextProfileId,
  parseAudioProfileCatalog,
  profileFromConfig,
} from '../src/lib/profiles';

const capabilities: BoardCapabilities = {
  board_id: 'board-a',
  board: 'Board A',
  codec: { driver: 'es8388', i2c_address: 16 },
  pins: { i2c: { sda: 1, scl: 2 }, i2s: { mclk: 3, bclk: 4, ws: 5, din: 6 } },
  status_led: null,
  input_lines: [{ line: 2, label: 'Line 2' }],
  input_gain_max: 100,
  adc_atten_max_db: 48,
};

// The device declares these; the console injects them so the parser stays pure.
const limits: AudioProfileImportLimits = {
  schemaVersion: 1,
  maxProfiles: 8,
  idPattern: '^[a-z0-9][a-z0-9-]*$',
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
  config_source: 'nvs',
};

const parse = (catalog: unknown) =>
  parseAudioProfileCatalog(JSON.stringify(catalog), capabilities, limits);

describe('audio profile model', () => {
  it('creates stable unique ids from display names', () => {
    expect(nextProfileId('Vinyl / Phono', [])).toBe('vinyl-phono');
    expect(nextProfileId('Vinyl', ['vinyl', 'vinyl-2'])).toBe('vinyl-3');
    expect(nextProfileId('レコード', [])).toBe('profile');
  });

  it('snapshots the applied device settings', () => {
    expect(profileFromConfig('vinyl', 'Vinyl', config)).toEqual({
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
      profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
    });

    expect(catalog.active_profile_id).toBeNull();
    expect(catalog.profiles[0].audio.adc_attenuation_db).toBe(12);
  });

  it('rejects wrong-board, duplicate, and over-capability data', () => {
    const base = {
      schema_version: 1,
      board_id: 'board-a',
      active_profile_id: null,
      profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
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
      profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
    };
    expect(() => parse({ ...base, schema_version: limits.schemaVersion + 1 })).toThrow(
      /schema_version/,
    );
    const tooMany = Array.from({ length: limits.maxProfiles + 1 }, (_, i) =>
      profileFromConfig(`profile-${i}`, 'Source', config),
    );
    expect(() => parse({ ...base, profiles: tooMany })).toThrow(/at most/);
    expect(() => parse({ ...base, profiles: [{ ...base.profiles[0], id: 'Bad_Id' }] })).toThrow(
      /invalid id/,
    );
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
      profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
    };
    expect(JSON.parse(exportAudioProfileCatalog(catalog)).active_profile_id).toBeNull();
  });
});
