/**
 * The stream target: the bridge host and port the device sends audio to. The
 * device keeps them apart, so the host is a bare name or address with no
 * port, scheme or path; one that carries any is refused, never split.
 */

/** The bridge's PCM port unless its deployment says otherwise. */
export const BRIDGE_PORT = 39000;

/** What the owner entered; the port as typed. */
export interface TargetEntry {
  host: string;
  port: string;
}

export interface TargetProblem {
  field: 'host' | 'port';
  text: string;
}

export function targetProblems(entry: TargetEntry): TargetProblem[] {
  const problems: TargetProblem[] = [];
  const host = entry.host.trim();
  if (host === '') {
    problems.push({ field: 'host', text: 'Enter the bridge’s name or address.' });
  } else if (host.includes('/')) {
    problems.push({
      field: 'host',
      text: 'Enter only the name or address, without http:// or a path.',
    });
  } else if (host.includes(':')) {
    problems.push({ field: 'host', text: 'Put the port in its own field.' });
  } else if (/\s/.test(host)) {
    problems.push({ field: 'host', text: 'A name or address has no spaces.' });
  }
  const port = entry.port.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    problems.push({ field: 'port', text: 'A port is a number from 1 to 65535.' });
  }
  return problems;
}

/** The fields a target save sends; only for an entry without problems. */
export function targetRequest(entry: TargetEntry): { target_host: string; target_port: number } {
  return { target_host: entry.host.trim(), target_port: Number(entry.port.trim()) };
}
