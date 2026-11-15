/**
 * A link into the bridge console, from an address the owner confirmed or a
 * bridge advertised. The audio target never stands in for it: the bridge
 * console listens on its own HTTP port.
 */
export function bridgeSourcesLink(address: string, source?: string): string | undefined {
  try {
    const url = new URL(address.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    url.hash = source === undefined ? '/sources' : `/sources/${encodeURIComponent(source)}`;
    return url.toString();
  } catch {
    return undefined;
  }
}
