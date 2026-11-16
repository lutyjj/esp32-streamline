import type { Place } from 'linen';
import { AudioLines, Disc3, Settings } from 'lucide-react';

/** The bridge console's places, in the order the journey reaches them. */
export const PLACES: readonly Place[] = [
  { href: '/sources', label: 'Sources', icon: AudioLines },
  { href: '/recordings', label: 'Recordings', icon: Disc3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export type PlaceName = 'sources' | 'recordings' | 'settings';

/** The place an address belongs to, or null for one the console does not have. */
export function placeOf(path: string): PlaceName | null {
  const first = path.split('/')[1];
  return PLACES.some((place) => place.href === `/${first}`) ? (first as PlaceName) : null;
}

/** What an address names beneath its place: a source id, or a section of Settings. */
export function itemOf(path: string): string | undefined {
  const item = path.split('/')[2];
  return item ? decodeURIComponent(item) : undefined;
}
