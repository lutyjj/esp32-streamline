import { describe, expect, it } from 'vitest';
import type { AudioProfileCatalog, BoardCapabilities, DeviceConfig } from '../src/lib/api';
import {
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
  input_lines: [{ line: 2, label: 'Line 2' }],
  input_gain_max: 100,
  adc_atten_max_db: 48,
};

const config: DeviceConfig = {
  device_name: '',
  ssid: 'home',
  target_host: '',
  target_port: 39000,
  auto_update_schedule: 'daily',
  input_line: 2,
  input_gain: 7,
  adc_atten_db: 12,
  config_source: 'nvs',
};

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
    const catalog = parseAudioProfileCatalog(
      JSON.stringify({
        schema_version: 1,
        board_id: 'board-a',
        active_profile_id: 'vinyl',
        profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
      }),
      capabilities,
    );

    expect(catalog.active_profile_id).toBeNull();
    expect(catalog.profiles[0].audio.adc_attenuation_db).toBe(12);
  });

  it('rejects wrong-board, duplicate, and out-of-range data', () => {
    const base = {
      schema_version: 1,
      board_id: 'board-a',
      active_profile_id: null,
      profiles: [profileFromConfig('vinyl', 'Vinyl', config)],
    };
    expect(() =>
      parseAudioProfileCatalog(JSON.stringify({ ...base, board_id: 'board-b' }), capabilities),
    ).toThrow(/different board/);
    expect(() =>
      parseAudioProfileCatalog(
        JSON.stringify({ ...base, profiles: [...base.profiles, ...base.profiles] }),
        capabilities,
      ),
    ).toThrow(/more than once/);
    expect(() =>
      parseAudioProfileCatalog(
        JSON.stringify({
          ...base,
          profiles: [
            {
              ...base.profiles[0],
              audio: { ...base.profiles[0].audio, adc_attenuation_db: 49 },
            },
          ],
        }),
        capabilities,
      ),
    ).toThrow(/limit/);
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
