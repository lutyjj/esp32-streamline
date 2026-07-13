import type { ComponentChildren } from 'preact';

/**
 * The placeholder shown where a list has no items yet. Keeps "nothing here"
 * looking deliberate and consistent instead of like a rendering gap.
 */
export function EmptyState({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}
