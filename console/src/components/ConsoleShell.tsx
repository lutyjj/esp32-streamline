import { type ComponentChildren, createContext } from 'preact';
import { ConsoleNavigation, type Destination } from './ConsoleNavigation';
import { ThemeSwitch } from './ThemeSwitch';

export const RequestUnlock = createContext<(() => void) | undefined>(undefined);

export function ConsoleShell({
  items,
  current,
  header,
  children,
  locked = false,
  onUnlock,
}: {
  items: readonly Destination[];
  current: string;
  header: ComponentChildren;
  children: ComponentChildren;
  locked?: boolean;
  onUnlock?: () => void;
}) {
  return (
    <RequestUnlock.Provider value={onUnlock}>
      <div class={`console-shell${locked ? ' locked' : ''}`}>
        <button
          type="button"
          class="skip-link"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('workspace')?.focus();
          }}
        >
          Skip to content
        </button>
        <aside class="console-rail">
          <div class="brand">StreamLine</div>
          <ConsoleNavigation items={items} current={current} />
          <div class="console-preferences">
            <ThemeSwitch />
          </div>
        </aside>
        <div class="console-body">
          <div class="console-topbar">{header}</div>
          <main id="workspace" class="workspace" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </RequestUnlock.Provider>
  );
}
