/** Authenticated console ingress is never a destination for an external player. */
export function playbackUrl(
  advertised: string | undefined,
  ingress: string,
  origin: string,
  source: string,
): string | undefined {
  if (!advertised && ingress) return undefined;
  try {
    const base = new URL(advertised || origin);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      return undefined;
    const url = new URL(`${base.toString().replace(/\/$/, '')}/streamline.wav`);
    url.searchParams.set('source', source);
    return url.toString();
  } catch {
    return undefined;
  }
}
