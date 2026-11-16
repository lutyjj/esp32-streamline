/** What both consoles' transports share: a refused request, and the fetch they call through. */

/** A request the server answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The fetch a console's requests go through, replaceable in tests. */
export type FetchLike = (request: Request) => Promise<Response>;
