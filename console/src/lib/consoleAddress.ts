/** An owner-confirmed management address; never infer HTTP from the PCM target. */
export function consoleAddress(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    url.hash = '/sources';
    return url.toString();
  } catch {
    return undefined;
  }
}
