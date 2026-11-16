/**
 * What both consoles' transports share: a refused request, one left
 * unanswered, and the fetch they call through.
 */

/** A request the server answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The request field the server refused, when it names one. */
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A form's errors after `error`: the server's reason under the field it
 * refused, when the form has that field. Empty for anything else, which the
 * form says in a notice instead.
 */
export function fieldErrors(error: unknown, fields: readonly string[]): Record<string, string> {
  return error instanceof ApiError && error.field !== null && fields.includes(error.field)
    ? { [error.field]: error.message }
    : {};
}

/** The fetch a console's requests go through, replaceable in tests. */
export type FetchLike = (request: Request) => Promise<Response>;

/** The server a console talks to, as its words name it. */
export type Peer = 'device' | 'bridge';

/** A request its server left unanswered past its bound; it may have arrived all the same. */
export class UnansweredError extends Error {
  constructor(readonly peer: Peer) {
    super(`the ${peer} did not answer in time`);
    this.name = 'UnansweredError';
  }
}

/** An exchange `peer` left unanswered past its bound fails in words a person can act on. */
export async function bounded<T>(peer: Peer, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new UnansweredError(peer);
    throw error;
  }
}
