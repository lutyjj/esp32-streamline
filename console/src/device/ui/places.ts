import type { Place } from 'linen';
import { AudioLines, Cpu, Waypoints, Wrench } from 'lucide-react';

/** The device console's places, in the order the journey reaches them. */
export const PLACES: readonly Place[] = [
  { href: '/audio', label: 'Audio', icon: AudioLines },
  { href: '/bridge', label: 'Bridge', icon: Waypoints },
  { href: '/device', label: 'Device', icon: Cpu },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench },
];

export type PlaceName = 'audio' | 'bridge' | 'device' | 'maintenance';

/** The place an address belongs to, or null for one the console does not have. */
export function placeOf(path: string): PlaceName | null {
  const first = path.split('/')[1];
  return PLACES.some((place) => place.href === `/${first}`) ? (first as PlaceName) : null;
}

/** The section an address names beneath its place, such as `wifi` in `/device/wifi`. */
export function sectionOf(path: string): string | undefined {
  return path.split('/')[2] || undefined;
}
