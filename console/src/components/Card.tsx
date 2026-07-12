import type { ComponentChildren } from 'preact';

interface CardProps {
  children: ComponentChildren;
  title?: string;
  lead?: ComponentChildren;
  gated?: boolean;
  className?: string;
}

export function Card({ children, title, lead, gated = false, className = '' }: CardProps) {
  return (
    <div class={`card${gated ? ' gated' : ''}${className ? ` ${className}` : ''}`}>
      {gated && <span class="lockhint">Unlock to edit</span>}
      {title && <h2>{title}</h2>}
      {lead && <p class="lead">{lead}</p>}
      {children}
    </div>
  );
}

export function CardFooter({
  children,
  flush = false,
  compact = false,
}: {
  children: ComponentChildren;
  flush?: boolean;
  compact?: boolean;
}) {
  return (
    <div class={`cardfoot${flush ? ' cardfoot-flush' : ''}${compact ? ' cardfoot-compact' : ''}`}>
      {children}
    </div>
  );
}

export function CardStack({ children }: { children: ComponentChildren }) {
  return <div class="cardstack">{children}</div>;
}
