/**
 * Saved audio profiles as the owner manages them: save the applied levels
 * under a name, replace, rename, remove, import and export. Each change
 * writes the whole catalog and reads it back; the device checks it and names
 * what it refuses. None of them applies a profile, which is selection's job.
 */

import {
  type Ack,
  type AudioProfileCatalog,
  setAudioProfile,
  setAudioProfiles,
} from '../../generated/api';
import {
  addProfile,
  exportAudioProfileCatalog,
  removeProfile,
  updateProfile,
} from '../lib/profiles';
import { withAccess, withRestart } from './access';
import { status } from './device';
import { audioProfilesQuery, queryClient, readAgain } from './queries';

/** What the catalog work needs from the device; throws while a part has not loaded. */
function loaded() {
  const catalog = queryClient.getQueryData(audioProfilesQuery.queryKey);
  const known = status.value;
  if (!catalog || !known) throw new Error('The profiles have not loaded yet.');
  return { catalog, known };
}

/** Write `catalog`, as JSON, and read it back. Resolves false when the owner declines to unlock. */
async function store(catalog: string): Promise<boolean> {
  const done = await withAccess(() => setAudioProfiles({ catalog }));
  if (done === null) return false;
  await readAgain(audioProfilesQuery);
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

/**
 * Apply profile `id`, or the custom levels for ''. A device without a
 * running codec restarts to apply it, and the restart reads the profiles
 * again; otherwise they are read again at once. Resolves null when the owner
 * declines to unlock.
 */
export async function switchProfile(id: string): Promise<Ack | null> {
  const done = await withRestart('the profile change', () => setAudioProfile({ profile_id: id }));
  if (done && !done.rebooting) await readAgain(audioProfilesQuery);
  return done;
}

export function exportProfiles(): string {
  return exportAudioProfileCatalog(loaded().catalog);
}
