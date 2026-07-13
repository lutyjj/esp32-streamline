/**
 * The stream target the device streams audio to. Host and port are separate
 * fields, so the host is a bare hostname or IP with no port, scheme, or path —
 * a value that smuggles one in is rejected rather than silently misparsed.
 */

export function normalizeTargetHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.includes(':') || trimmed.includes('/')) {
    throw new Error('target host must not include port, scheme, or path');
  }
  return trimmed;
}
