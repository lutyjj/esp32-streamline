import * as v from 'valibot';

/** The request fields `body` breaks under `rule`, the contract's generated rule for its request. */
export function brokenFields(rule: v.GenericSchema, body: unknown): ReadonlySet<string> {
  const issues = v.safeParse(rule, body).issues ?? [];
  return new Set(issues.map((issue) => String(issue.path?.[0]?.key)));
}
