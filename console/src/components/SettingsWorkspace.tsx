import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';

export interface SettingsSection {
  id: string;
  label: string;
  content: ComponentChildren;
}

/** Visited settings remain mounted so changing sections preserves unfinished edits. */
export function SettingsWorkspace({
  label,
  sections,
}: {
  label: string;
  sections: readonly SettingsSection[];
}) {
  const id = useId();
  const [selected, setSelected] = useState(sections[0].id);
  const [visited, setVisited] = useState([sections[0].id]);
  function select(next: string) {
    setSelected(next);
    setVisited((items) => (items.includes(next) ? items : [...items, next]));
  }
  return (
    <div class="settings-workspace">
      <nav class="settings-nav" aria-label={label}>
        {sections.map((section) => (
          <button
            type="button"
            key={section.id}
            aria-current={selected === section.id ? 'page' : undefined}
            aria-controls={visited.includes(section.id) ? `${id}-${section.id}` : undefined}
            onClick={() => select(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <label class="settings-select">
        {label}
        <select value={selected} onChange={(event) => select(event.currentTarget.value)}>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.label}
            </option>
          ))}
        </select>
      </label>
      <div class="settings-content">
        {sections
          .filter((section) => visited.includes(section.id))
          .map((section) => (
            <section key={section.id} id={`${id}-${section.id}`} hidden={selected !== section.id}>
              {section.content}
            </section>
          ))}
      </div>
    </div>
  );
}
