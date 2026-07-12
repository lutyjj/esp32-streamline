import { useEffect, useState } from 'preact/hooks';

export const CONSOLE_VIEWS = ['overview', 'audio', 'network', 'system', 'api'] as const;
export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

export const CONSOLE_NAVIGATION: ReadonlyArray<{ view: ConsoleView; label: string }> = [
  { view: 'overview', label: 'Overview' },
  { view: 'audio', label: 'Audio' },
  { view: 'network', label: 'Network' },
  { view: 'system', label: 'System' },
  { view: 'api', label: 'API' },
];

export function viewFromHash(hash: string): ConsoleView {
  const candidate = hash.replace(/^#\/?/, '').split(/[/?]/, 1)[0];
  return CONSOLE_VIEWS.find((view) => view === candidate) ?? 'overview';
}

export function viewHref(view: ConsoleView) {
  return `#/${view}`;
}

export function navigateTo(view: ConsoleView) {
  const href = viewHref(view);
  if (window.location.hash === href) return;
  window.location.hash = href;
}

export function useConsoleView(): ConsoleView {
  const [view, setView] = useState(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const syncFromLocation = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', syncFromLocation);
    return () => window.removeEventListener('hashchange', syncFromLocation);
  }, []);

  return view;
}
