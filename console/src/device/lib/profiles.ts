/**
 * Catalog edits for saved audio profiles. The device checks every catalog it
 * is sent and names what it refuses, so these only shape the change.
 */

import * as v from 'valibot';
import type { AudioProfileCatalog, AudioSettings } from '../../generated/api';
import { AudioProfile } from '../../generated/rules';

export function profileFromAudio(id: string, name: string, audio: AudioSettings) {
  return {
    id,
    name,
    audio: {
      input_line: audio.input_line,
      input_gain: audio.input_gain,
      adc_attenuation_db: audio.adc_attenuation_db,
    },
  };
}

/** Add a profile that snapshots `audio`, and return its new id so the caller can select it. */
export function addProfile(
  catalog: AudioProfileCatalog,
  name: string,
  audio: AudioSettings,
): { catalog: AudioProfileCatalog; id: string } {
  const trimmed = name.trim();
  const id = nextProfileId(
    trimmed,
    catalog.profiles.map((profile) => profile.id),
  );
  return {
    catalog: { ...catalog, profiles: [...catalog.profiles, profileFromAudio(id, trimmed, audio)] },
    id,
  };
}

/** Re-snapshot an existing profile under `name`. */
export function updateProfile(
  catalog: AudioProfileCatalog,
  id: string,
  name: string,
  audio: AudioSettings,
): AudioProfileCatalog {
  return {
    ...catalog,
    profiles: catalog.profiles.map((profile) =>
      profile.id === id ? profileFromAudio(id, name.trim(), audio) : profile,
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
 * A readable id from `name` that the contract's id rule accepts and no saved
 * profile has: the name's letters and digits, shortened to fit, with a number
 * after it when taken.
 */
export function nextProfileId(name: string, usedIds: Iterable<string>): string {
  const used = new Set(usedIds);
  const valid = (id: string) => v.is(AudioProfile.entries.id, id);
  const slug =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile';
  for (let count = 1; count < 1000; count += 1) {
    const suffix = count === 1 ? '' : `-${count}`;
    let stem = slug;
    while (stem && !valid(`${stem}${suffix}`)) stem = stem.slice(0, -1).replace(/-+$/, '');
    if (stem && !used.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
  }
  throw new Error('No free profile id is left for this name.');
}

export function exportAudioProfileCatalog(catalog: AudioProfileCatalog): string {
  return `${JSON.stringify({ ...catalog, active_profile_id: null }, null, 2)}\n`;
}
