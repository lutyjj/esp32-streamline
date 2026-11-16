/**
 * Links into the bridge console, from an address the owner confirmed or a
 * bridge advertised. The audio target never stands in for it: the bridge
 * console listens on its own HTTP port.
 */
function bridgeLink(address: string, route: string): string | undefined {
  try {
    const url = new URL(address.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    url.hash = route;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Sources, or one source in it. */
export function bridgeSourcesLink(address: string, source?: string): string | undefined {
  return bridgeLink(
    address,
    source === undefined ? '/sources' : `/sources/${encodeURIComponent(source)}`,
  );
}

/** Settings → Audio security, where a device's credential is added. */
export function bridgeSecurityLink(address: string): string | undefined {
  return bridgeLink(address, '/settings/security');
}

/** Why the console cannot link to `address`, or null when it can, or when there is none. */
export function consoleAddressProblem(address: string): string | null {
  if (address.trim() === '' || bridgeSourcesLink(address)) return null;
  return 'Use the address the bridge console opens at, starting with http:// or https://.';
}
