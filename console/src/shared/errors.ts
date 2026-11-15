/** The human-readable message of anything a promise can reject with. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
