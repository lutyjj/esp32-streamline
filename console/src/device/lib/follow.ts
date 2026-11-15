/**
 * A field that mirrors a value the device also reports live. It follows the
 * device while the owner has not changed it, so a button press or another
 * client shows up within one read. Once the owner changes it, it keeps their
 * value, and "unsaved" measures it against whatever the device holds now.
 */

export interface Followed<T> {
  value: T;
  /** What the device holds. */
  applied: T;
  /** Counts the times the device moved the field under the owner, for a cue. */
  moved: number;
}

export function seeded<T>(live: T): Followed<T> {
  return { value: live, applied: live, moved: 0 };
}

export function followed<T>(field: Followed<T>, live: T): Followed<T> {
  if (Object.is(live, field.applied)) return field;
  if (!Object.is(field.value, field.applied)) return { ...field, applied: live };
  return { value: live, applied: live, moved: field.moved + 1 };
}

export function edited<T>(field: Followed<T>, value: T): Followed<T> {
  return { ...field, value };
}

export function unsaved<T>(field: Followed<T>): boolean {
  return !Object.is(field.value, field.applied);
}

/** Back to what the device holds. */
export function discarded<T>(field: Followed<T>): Followed<T> {
  return { ...field, value: field.applied };
}
