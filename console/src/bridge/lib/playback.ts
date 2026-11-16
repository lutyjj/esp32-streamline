/**
 * Where a player opens a source. The bridge's advertised public URL wins.
 * Without one, a page served at the bridge's own root vouches for its
 * origin; a page under a path prefix, such as Home Assistant's ingress, does
 * not, since a player cannot pass the browser's session there.
 */
export function playbackUrl(publicUrl: string, page: string, source: string): string | undefined {
  const base = publicUrl || (new URL('.', page).pathname === '/' ? new URL(page).origin : '');
  if (!base) return undefined;
  const url = new URL(`${base.replace(/\/$/, '')}/streamline.wav`);
  url.searchParams.set('source', source);
  return url.toString();
}
