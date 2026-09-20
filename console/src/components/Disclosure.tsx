import type { ComponentChildren } from 'preact';
import { useId, useRef, useState } from 'preact/hooks';

interface DisclosureProps {
  title: string;
  description?: string;
  children: ComponentChildren;
  className?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

export function Disclosure({
  title,
  description,
  children,
  className = '',
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
}: DisclosureProps) {
  const panelId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const visited = useRef(open);
  if (open) visited.current = true;
  return (
    <div class={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        class="disclosure-summary"
        type="button"
        aria-label={title}
        aria-expanded={open}
        aria-controls={visited.current ? panelId : undefined}
        onClick={() => {
          setLocalOpen(!open);
          onToggle?.(!open);
        }}
      >
        <span class="disclosure-heading">
          {title}
          {description && <small>{description}</small>}
        </span>
        <svg
          class="disclosure-indicator"
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {visited.current && (
        <div class="disclosure-panel" hidden={!open} id={panelId}>
          <div class="disclosure-body">{children}</div>
        </div>
      )}
    </div>
  );
}
