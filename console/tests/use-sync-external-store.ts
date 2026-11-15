/**
 * Base UI's `use-sync-external-store` on Preact's own hook, for tests: the
 * package ships only as CommonJS, which Vitest loads in Node past every alias.
 * The browser bundle compiles the package itself.
 */
import { useCallback, useRef, useSyncExternalStore } from 'preact/compat';

export { useSyncExternalStore };

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  _getServerSnapshot: unknown,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const last = useRef<{ snapshot: Snapshot; selection: Selection } | null>(null);
  const select = useCallback(() => {
    const snapshot = getSnapshot();
    const held = last.current;
    if (held !== null && Object.is(held.snapshot, snapshot)) return held.selection;
    const selection = selector(snapshot);
    if (held !== null && isEqual?.(held.selection, selection) === true) {
      last.current = { snapshot, selection: held.selection };
      return held.selection;
    }
    last.current = { snapshot, selection };
    return selection;
  }, [getSnapshot, selector, isEqual]);
  return useSyncExternalStore(subscribe, select);
}
