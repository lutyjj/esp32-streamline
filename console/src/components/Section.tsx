import type { ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import { RequestUnlock } from './ConsoleShell';

export function Section({
  children,
  title,
  lead,
  gated = false,
  className = '',
}: {
  children: ComponentChildren;
  title?: string;
  lead?: ComponentChildren;
  gated?: boolean;
  className?: string;
}) {
  const unlock = useContext(RequestUnlock);
  return (
    <section class={`section${gated ? ' gated' : ''}${className ? ` ${className}` : ''}`}>
      {(title || lead || gated) && (
        <header class="section-heading">
          <div>
            {title && <h2>{title}</h2>}
            {lead && <p class="lead">{lead}</p>}
          </div>
          {gated &&
            (unlock ? (
              <button type="button" class="lockhint" onClick={unlock}>
                Unlock to edit
              </button>
            ) : (
              <span class="lockhint">Unlock to edit</span>
            ))}
        </header>
      )}
      {children}
    </section>
  );
}
export function SectionActions({
  children,
  compact = false,
}: {
  children: ComponentChildren;
  compact?: boolean;
}) {
  return (
    <div class={`section-actions${compact ? ' section-actions-compact' : ''}`}>{children}</div>
  );
}
export function SectionStack({ children }: { children: ComponentChildren }) {
  return <div class="section-stack">{children}</div>;
}
