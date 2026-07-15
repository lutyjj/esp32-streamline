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

/** A name the device will store: trimmed, present, and within the length limit. */
function validProfileName(name: string, limits: AudioProfileConstraints): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Enter a profile name');
  if ([...trimmed].length > limits.nameMaxChars) {
    throw new Error(`Profile names are limited to ${limits.nameMaxChars} characters`);
  }
  return trimmed;
}

/**
 * Add a profile that snapshots the applied settings. Rejects a blank or
 * over-long name and a catalog already at the device's profile limit, and
 * returns the new id so the caller can select it.
 */
export function addProfile(
  catalog: AudioProfileCatalog,
  name: string,
  config: DeviceConfig,
  limits: AudioProfileConstraints,
): { catalog: AudioProfileCatalog; id: string } {
  const trimmed = validProfileName(name, limits);
  if (catalog.profiles.length >= limits.maxProfiles) {
    throw new Error(`This device stores up to ${limits.maxProfiles} profiles`);
  }
  const id = nextProfileId(
    trimmed,
    catalog.profiles.map((profile) => profile.id),
    limits,
  );
  return {
    catalog: {
      ...catalog,
      profiles: [...catalog.profiles, profileFromConfig(id, trimmed, config)],
    },
    id,
  };
}

/** Re-snapshot an existing profile from the applied settings under a valid name. */
export function updateProfile(
  catalog: AudioProfileCatalog,
  id: string,
  name: string,
  config: DeviceConfig,
  limits: AudioProfileConstraints,
): AudioProfileCatalog {
  const trimmed = validProfileName(name, limits);
  return {
    ...catalog,
    profiles: catalog.profiles.map((profile) =>
      profile.id === id ? profileFromConfig(id, trimmed, config) : profile,
    ),
  };
}

/** Remove a profile, clearing the active pointer when it named the removed one. */
export function removeProfile(catalog: AudioProfileCatalog, id: string): AudioProfileCatalog {
  return {
    ...catalog,
    active_profile_id: catalog.active_profile_id === id ? null : catalog.active_profile_id,
    profiles: catalog.profiles.filter((profile) => profile.id !== id),
  };
}

/**
 * Allocate a readable id within the limits declared by the device. Slugging
 * intentionally supports the current lowercase ASCII vocabulary; a contract
 * that changes that vocabulary fails here instead of producing an invalid
 * request.
 */
export function nextProfileId(
  name: string,
  usedIds: Iterable<string>,
  limits: AudioProfileConstraints,
): string {
  const valid = profileIdValidator(limits);
  const used = new Set(usedIds);
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const seed = slug || 'profile';
  const fitStem = (minimum: number, maximum: number): string => {
    const target = Math.min(maximum, Math.max(minimum, seed.length));
    let stem = seed;
    while (stem.length < target) stem += '-profile';
    stem = stem.slice(0, target).replace(/-+$/g, '');
    while (stem.length < minimum) stem += 'p';
    return stem;
  };
  const base = fitStem(limits.idMinChars, limits.idMaxChars);
  if (valid(base) && !used.has(base)) return base;
  for (const separator of ['-', '']) {
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const suffixText = `${separator}${suffix}`;
      const maximumStem = limits.idMaxChars - suffixText.length;
      const minimumStem = Math.max(1, limits.idMinChars - suffixText.length);
      if (maximumStem < minimumStem) continue;
      const candidate = `${fitStem(minimumStem, maximumStem)}${suffixText}`;
      if (valid(candidate) && !used.has(candidate)) return candidate;
    }
  }
  throw new Error('device contract cannot generate a unique audio profile id from this name');
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

  const validId = profileIdValidator(limits);
  const ids = new Set<string>();
  const profiles = value.profiles.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`profile ${index + 1} is not an object`);
    const id = candidate.id;
    const name = candidate.name;
    if (typeof id !== 'string' || !validId(id)) {
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

/** Compile the device's JSON-Schema constraint once for create and import. */
function profileIdValidator(limits: AudioProfileConstraints): (id: string) => boolean {
  if (
    !Number.isInteger(limits.idMinChars) ||
    !Number.isInteger(limits.idMaxChars) ||
    limits.idMinChars < 0 ||
    limits.idMaxChars < 1 ||
    limits.idMinChars > limits.idMaxChars
  ) {
    throw new Error('device contract has invalid audio profile id length limits');
  }
  const pattern = new RegExp(limits.idPattern, 'u');
  return (id) => {
    const characters = [...id].length;
    return characters >= limits.idMinChars && characters <= limits.idMaxChars && pattern.test(id);
  };
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}
