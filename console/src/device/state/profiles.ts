/**
 * Saved audio profiles as the owner manages them: save the applied levels
 * under a name, replace, rename, remove, import and export. Each change
 * writes the whole catalog and reads it back; none of them applies a profile,
 * which is selection's job.
 */

import { type AudioProfileCatalog, setAudioProfiles } from '../../generated/api';
import {
  addProfile,
  exportAudioProfileCatalog,
  parseAudioProfileCatalog,
  removeProfile,
  updateProfile,
} from '../lib/profiles';
import { withAccess } from './access';
import { audioProfileLimits, audioProfiles, loadAudioProfiles, status } from './device';

/** What the catalog work needs from the device; throws while a part has not loaded. */
function loaded() {
  const catalog = audioProfiles.value;
  const limits = audioProfileLimits.value;
  const known = status.value;
  if (!catalog || !limits || !known) throw new Error('The profiles have not loaded yet.');
  return { catalog, limits, known };
}

/** Write `next` and read it back. Resolves false when the owner declines to unlock. */
async function store(next: AudioProfileCatalog): Promise<boolean> {
  const done = await withAccess(() => setAudioProfiles({ catalog: JSON.stringify(next) }));
  if (done === null) return false;
  await loadAudioProfiles();
  return true;
}

/** Keep the applied levels, never a draft, under `name`. */
export async function saveProfile(name: string): Promise<boolean> {
  const { catalog, limits, known } = loaded();
  return store(addProfile(catalog, name, known.audio, limits).catalog);
}

/** Give profile `id` the applied levels, keeping its name. */
export async function replaceProfile(id: string): Promise<boolean> {
  const { catalog, limits, known } = loaded();
  const profile = catalog.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('That profile is gone.');
  return store(updateProfile(catalog, id, profile.name, known.audio, limits));
}

export async function renameProfile(id: string, name: string): Promise<boolean> {
  const { catalog, limits } = loaded();
  const profile = catalog.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('That profile is gone.');
  return store(updateProfile(catalog, id, name, profile.audio, limits));
}

export async function deleteProfile(id: string): Promise<boolean> {
  return store(removeProfile(loaded().catalog, id));
}

/** Replace the catalog with an exported one; throws with the reason it does not fit. */
export async function importProfiles(text: string): Promise<boolean> {
  const { limits, known } = loaded();
  return store(parseAudioProfileCatalog(text, known.capabilities, limits));
}

export function exportProfiles(): string {
  return exportAudioProfileCatalog(loaded().catalog);
}
