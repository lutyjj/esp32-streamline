/**
 * Saved audio profiles as the owner manages them: save the applied levels
 * under a name, replace, rename, remove, import and export. Each change
 * writes the whole catalog and reads it back; the device checks it and names
 * what it refuses. None of them applies a profile, which is selection's job.
 */

import { type AudioProfileCatalog, setAudioProfiles } from '../../generated/api';
import {
  addProfile,
  exportAudioProfileCatalog,
  removeProfile,
  updateProfile,
} from '../lib/profiles';
import { withAccess } from './access';
import { audioProfiles, loadAudioProfiles, status } from './device';

/** What the catalog work needs from the device; throws while a part has not loaded. */
function loaded() {
  const catalog = audioProfiles.value;
  const known = status.value;
  if (!catalog || !known) throw new Error('The profiles have not loaded yet.');
  return { catalog, known };
}

/** Write `catalog`, as JSON, and read it back. Resolves false when the owner declines to unlock. */
async function store(catalog: string): Promise<boolean> {
  const done = await withAccess(() => setAudioProfiles({ catalog }));
  if (done === null) return false;
  await loadAudioProfiles();
  return true;
}

function storeCatalog(next: AudioProfileCatalog): Promise<boolean> {
  return store(JSON.stringify(next));
}

/** Keep the applied levels, never a draft, under `name`. */
export async function saveProfile(name: string): Promise<boolean> {
  const { catalog, known } = loaded();
  return storeCatalog(addProfile(catalog, name, known.audio).catalog);
}

/** Give profile `id` the applied levels, keeping its name. */
export async function replaceProfile(id: string): Promise<boolean> {
  const { catalog, known } = loaded();
  const profile = catalog.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('That profile is gone.');
  return storeCatalog(updateProfile(catalog, id, profile.name, known.audio));
}

export async function renameProfile(id: string, name: string): Promise<boolean> {
  const { catalog } = loaded();
  const profile = catalog.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('That profile is gone.');
  return storeCatalog(updateProfile(catalog, id, name, profile.audio));
}

export async function deleteProfile(id: string): Promise<boolean> {
  return storeCatalog(removeProfile(loaded().catalog, id));
}

/**
 * Replace the catalog with an exported one, as the file holds it. The device
 * refuses a file that does not fit it, with the reason.
 */
export function importProfiles(text: string): Promise<boolean> {
  return store(text);
}

export function exportProfiles(): string {
  return exportAudioProfileCatalog(loaded().catalog);
}
