export interface Destination {
  view: string;
  label: string;
  description: string;
}

export function ConsoleNavigation({
  items,
  current,
}: {
  items: readonly Destination[];
  current: string;
}) {
  return (
    <nav class="tabs" aria-label="Console">
      {items.map(({ view, label }) => (
        <a
          key={view}
          id={`nav-${view}`}
          href={`#/${view}`}
          aria-current={current === view ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function PageHeading({ label, description }: { label: string; description?: string }) {
  return (
    <div class="page-heading">
      <h1>{label}</h1>
      {description && <p>{description}</p>}
    </div>
  );
}
