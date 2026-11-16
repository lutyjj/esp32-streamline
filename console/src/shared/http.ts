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

/** A refusal of one of a form's `fields`, in the server's words, or null for any other failure. */
export function fieldRefusal<F extends string>(
  error: unknown,
  fields: readonly F[],
): { field: F; text: string } | null {
  if (!(error instanceof ApiError)) return null;
  const field = fields.find((name) => name === error.field);
  return field ? { field, text: error.message } : null;
}

/** The fetch a console's requests go through, replaceable in tests. */
export type FetchLike = (request: Request) => Promise<Response>;
