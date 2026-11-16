/** What both consoles' transports share: a refused request, and the fetch they call through. */

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
