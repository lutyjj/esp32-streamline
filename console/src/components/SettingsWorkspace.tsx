import './settings.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';

export interface SettingsSection {
  id: string;
  label: string;
  description?: string;
  content: ComponentChildren;
}

/** Visited settings remain mounted so changing sections preserves unfinished edits. */
export function SettingsWorkspace({
  label,
  sections,
  selected: requested,
  baseHref,
}: {
  label: string;
  sections: readonly SettingsSection[];
  selected?: string;
  baseHref: string;
}) {
  const id = useId();
  const selected = sections.find((section) => section.id === requested)?.id;
  const [visited, setVisited] = useState([selected]);
  useEffect(() => {
    if (selected) setVisited((items) => (items.includes(selected) ? items : [...items, selected]));
  }, [selected]);
  return (
    <div class="settings-workspace">
      <nav class="settings-nav" aria-label={label} hidden={Boolean(selected)}>
        {sections.map((section) => (
          <a
            href={`${baseHref}/${section.id}`}
            key={section.id}
            aria-current={selected === section.id ? 'page' : undefined}
            aria-controls={visited.includes(section.id) ? `${id}-${section.id}` : undefined}
          >
            <span>
              <strong>{section.label}</strong>
              {section.description && <small>{section.description}</small>}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="m8 5 5 5-5 5" />
            </svg>
          </a>
        ))}
      </nav>
      {selected && (
        <nav class="settings-location" aria-label="Settings location">
          <a class="btn secondary settings-back" href={baseHref}>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="m9 5-5 5 5 5M4 10h12" />
            </svg>
            All settings
          </a>
          <span aria-current="page">
            {sections.find((section) => section.id === selected)?.label}
          </span>
        </nav>
      )}
      <div class="settings-content">
        {sections
          .filter((section) => section.id === selected || visited.includes(section.id))
          .map((section) => (
            <section key={section.id} id={`${id}-${section.id}`} hidden={selected !== section.id}>
              {section.content}
            </section>
          ))}
      </div>
    </div>
  );
}
