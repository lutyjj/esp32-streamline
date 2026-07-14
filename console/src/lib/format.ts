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

/** Byte count as a compact 1024-based string: `512 B`, `124 KB`, `1.9 MB`. */
export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  // Round to whole kilobytes first, so a value that rounds up to 1024 KB rolls
  // into megabytes instead of printing "1024 KB".
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${kb} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fraction of a resource in use (0..100), clamped, guarding a zero total. */
export function usagePct(value: number, max: number): number {
  if (!max || max < 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/** Headroom tone: comfortable below 80% used, tight past it, critical near full. */
export function usageTone(pct: number): 'good' | 'warn' | 'bad' {
  if (pct >= 95) return 'bad';
  if (pct >= 80) return 'warn';
  return 'good';
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
