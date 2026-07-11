import type { AudioProfile, AudioProfileCatalog, BoardCapabilities, DeviceConfig } from './api';
import type { AudioProfileConstraints } from './contract';

/**
 * The limits an import is checked against: the structural bounds the device
 * declares on its contract plus the catalog schema version it currently speaks.
 * Both are device facts, injected so this stays a pure, testable unit.
 */
export interface AudioProfileImportLimits extends AudioProfileConstraints {
  schemaVersion: number;
}

export function profileFromConfig(id: string, name: string, config: DeviceConfig): AudioProfile {
  return {
    id,
    name,
    audio: {
      input_line: config.input_line,
      input_gain: config.input_gain,
      adc_attenuation_db: config.adc_attenuation_db,
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
  limits: AudioProfileImportLimits,
): AudioProfileCatalog {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('profile catalog is not valid JSON');
  }
  if (!isRecord(value) || value.schema_version !== limits.schemaVersion) {
    throw new Error(`profile catalog schema_version must be ${limits.schemaVersion}`);
  }
  if (value.board_id !== capabilities.board_id) {
    throw new Error(`profiles are for a different board (${String(value.board_id || 'unknown')})`);
  }
  if (!Array.isArray(value.profiles) || value.profiles.length > limits.maxProfiles) {
    throw new Error(`profile catalog must contain at most ${limits.maxProfiles} profiles`);
  }

  const idPattern = new RegExp(limits.idPattern);
  const ids = new Set<string>();
  const profiles = value.profiles.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`profile ${index + 1} is not an object`);
    const id = candidate.id;
    const name = candidate.name;
    if (typeof id !== 'string' || id.length > limits.idMaxChars || !idPattern.test(id)) {
      throw new Error(`profile ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) throw new Error(`profile id '${id}' appears more than once`);
    ids.add(id);
    if (
      typeof name !== 'string' ||
      name.trim() !== name ||
      name.length === 0 ||
      [...name].length > limits.nameMaxChars
    ) {
      throw new Error(`profile '${id}' has an invalid name`);
    }
    if (!isRecord(candidate.audio)) throw new Error(`profile '${id}' audio is not an object`);
    const input_line = nonNegativeInteger(candidate.audio.input_line, `profile '${id}' input_line`);
    const input_gain = nonNegativeInteger(candidate.audio.input_gain, `profile '${id}' input_gain`);
    const adc_attenuation_db = nonNegativeInteger(
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
    schema_version: limits.schemaVersion,
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

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}
