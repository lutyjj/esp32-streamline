import { useEffect, useState } from 'preact/hooks';

/** Hash destinations preserve task intent across reloads and browser history. */
export function useRouteHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return hash;
}

export function sectionFromHash(hash: string, workspace: string): string | undefined {
  const [view, section] = hash.replace(/^#\/?/, '').split('/');
  return view === workspace ? section?.split('?')[0] : undefined;
}
