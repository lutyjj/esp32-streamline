import type { ComponentChildren } from 'preact';

/** A top-level section heading with a right-aligned eyebrow note. */
export function SectionHead({ title, note }: { title: string; note: ComponentChildren }) {
  return (
    <div class="section-head">
      <h2>{title}</h2>
      <span class="eyebrow">{note}</span>
    </div>
  );
}
