import type { AudioProfile, AudioProfileCatalog, BoardCapabilities, DeviceConfig } from './api';

export const MAX_AUDIO_PROFILES = 8;
export const MAX_AUDIO_PROFILE_NAME_CHARS = 32;

export function profileFromConfig(id: string, name: string, config: DeviceConfig): AudioProfile {
  return {
    id,
    name,
    audio: {
      input_line: config.input_line,
      input_gain: config.input_gain,
      adc_attenuation_db: config.adc_atten_db,
    },
  };
}

export function nextProfileId(name: string, usedIds: Iterable<string>): string {
  const used = new Set(usedIds);
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/g, '') || 'profile';
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 32 - String(suffix).length - 1)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('could not allocate a profile id');
}

/** Parse shared bytes once into the same bounded model the firmware accepts. */
export function parseAudioProfileCatalog(
  text: string,
  capabilities: BoardCapabilities,
): AudioProfileCatalog {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('profile catalog is not valid JSON');
  }
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error('profile catalog schema_version must be 1');
  }
  if (value.board_id !== capabilities.board_id) {
    throw new Error(`profiles are for a different board (${String(value.board_id || 'unknown')})`);
  }
  if (!Array.isArray(value.profiles) || value.profiles.length > MAX_AUDIO_PROFILES) {
    throw new Error(`profile catalog must contain at most ${MAX_AUDIO_PROFILES} profiles`);
  }

  const ids = new Set<string>();
  const profiles = value.profiles.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`profile ${index + 1} is not an object`);
    const id = candidate.id;
    const name = candidate.name;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      throw new Error(`profile ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) throw new Error(`profile id '${id}' appears more than once`);
    ids.add(id);
    if (
      typeof name !== 'string' ||
      name.trim() !== name ||
      name.length === 0 ||
      [...name].length > MAX_AUDIO_PROFILE_NAME_CHARS
    ) {
      throw new Error(`profile '${id}' has an invalid name`);
    }
    if (!isRecord(candidate.audio)) throw new Error(`profile '${id}' audio is not an object`);
    const input_line = boundedInteger(candidate.audio.input_line, `profile '${id}' input_line`);
    const input_gain = boundedInteger(candidate.audio.input_gain, `profile '${id}' input_gain`);
    const adc_attenuation_db = boundedInteger(
      candidate.audio.adc_attenuation_db,
      `profile '${id}' adc_attenuation_db`,
    );
    if (!capabilities.input_lines.some((option) => option.line === input_line)) {
      throw new Error(`profile '${id}' uses an input line this board does not expose`);
    }
    if (input_gain > capabilities.input_gain_max) {
      throw new Error(`profile '${id}' input gain exceeds this board's limit`);
    }
    if (adc_attenuation_db > capabilities.adc_atten_max_db) {
      throw new Error(`profile '${id}' ADC attenuation exceeds this board's limit`);
    }
    return { id, name, audio: { input_line, input_gain, adc_attenuation_db } };
  });

  return {
    schema_version: 1,
    board_id: capabilities.board_id,
    // Importing definitions never changes the active source or live levels.
    active_profile_id: null,
    profiles,
  };
}

export function exportAudioProfileCatalog(catalog: AudioProfileCatalog): string {
  return `${JSON.stringify({ ...catalog, active_profile_id: null }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${field} must be an integer from 0 to 255`);
  }
  return value;
}
