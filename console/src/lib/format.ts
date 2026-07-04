/** Absolute sample value (0..32768) as dBFS text; silence reads as -inf. */
export function dbfs(abs: number): string {
  if (!abs) return '-inf';
  return (20 * Math.log10(abs / 32768)).toFixed(1);
}

/** Absolute sample value as a 0-100% meter position on a -60..0 dBFS scale. */
export function meterPct(abs: number): number {
  if (!abs) return 0;
  const db = 20 * Math.log10(abs / 32768);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}
