import type { GaugeZone } from 'linen';

/** Decibels to a tenth; a value that rounds to zero from below carries no sign. */
function tenths(db: number): string {
  const text = db.toFixed(1);
  return text === '-0.0' ? '0.0' : text;
}

/** Absolute sample value (0..32768) as dBFS text; silence reads as -inf. */
export function dbfs(abs: number): string {
  if (!abs) return '-inf';
  return tenths(20 * Math.log10(abs / 32768));
}

/** The floor of a level scale in dBFS; anything quieter, silence included, reads as it. */
export const LEVEL_FLOOR_DB = -60;

/** Absolute sample value (0..32768) in dBFS, held to the level scale's floor. */
export function levelDb(abs: number): number {
  if (!abs) return LEVEL_FLOOR_DB;
  return Math.max(LEVEL_FLOOR_DB, Math.min(0, 20 * Math.log10(abs / 32768)));
}

/** A level gauge's tones, as audio meters wear them: safe, hot near the top, clipping in its last decibel. */
export const LEVEL_ZONES: readonly GaugeZone[] = [
  { from: LEVEL_FLOOR_DB, to: -6, tone: 'positive' },
  { from: -6, to: -1, tone: 'warn' },
  { from: -1, to: 0, tone: 'danger' },
];

/** A level in dBFS as a gauge reads it out. */
export function levelText(value: number): string {
  return value <= LEVEL_FLOOR_DB ? 'silent' : `${tenths(value)} dB`;
}

/** Byte count as a compact 1024-based string: `512 B`, `124 KB`, `1.9 MB`. */
export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  // Round to whole kilobytes first, so a value that rounds up to 1024 KB rolls
  // into megabytes instead of printing "1024 KB".
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${kb} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Elapsed seconds as compact uptime, top two units: `45s`, `5m 20s`, `2h 5m`, `3d 4h`. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
