/**
 * linen's navigation for a console served as one file: every address lives in
 * the hash (`#/bridge/encryption`), so a reload keeps the place and the server
 * needs no route per screen. Moves an unsaved draft holds wait here, whether
 * they come from a link or from the browser's Back and Forward.
 */

import type { Blocker, LinkProps, Navigation } from 'linen';
import { type MouseEvent, useEffect, useRef, useSyncExternalStore } from 'react';

/** The path a hash names; anything that is not a path names the root. */
export function hashPath(hash: string): string {
  const path = hash.replace(/^#/, '');
  return path.startsWith('/') ? path : '/';
}

type Hold = (nextPathname: string) => boolean;

const listeners = new Set<() => void>();
const holds = new Set<{ current: Hold }>();
/** The place on screen, which a held move leaves as it is. */
let here = hashPath(window.location.hash);
/** The move a hold is waiting on, if any. */
let waiting: string | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function held(next: string): boolean {
  return next !== here && [...holds].some((hold) => hold.current(next));
}

window.addEventListener('hashchange', () => {
  const next = hashPath(window.location.hash);
  if (held(next)) {
    // Back and Forward have already moved the address: put it back in place.
    window.history.replaceState(window.history.state, '', `#${here}`);
    waiting = next;
  } else {
    here = next;
  }
  notify();
});

/** Move to `path`, as a link does. */
export function navigate(path: string): void {
  if (held(path)) {
    waiting = path;
    notify();
    return;
  }
  window.location.hash = path;
}

/** Show `path` in place of the current address, such as a screen's first section. */
export function replacePath(path: string): void {
  window.history.replaceState(window.history.state, '', `#${path}`);
  here = path;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The path on screen, followed as it changes. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => here);
}

/** A click the browser should handle itself: a new tab, a download, a modifier key. */
function opensElsewhere(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    Boolean(event.currentTarget.target)
  );
}

/** A link within the console, which waits while an unsaved draft holds the move. */
export function Link({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={`#${href}`}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || opensElsewhere(event)) return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

function useBlocker(when: Hold): Blocker {
  const hold = useRef(when);
  hold.current = when;
  useEffect(() => {
    holds.add(hold);
    return () => {
      holds.delete(hold);
    };
  }, []);
  const pending = useSyncExternalStore(subscribe, () => waiting);
  return {
    blocked: pending !== null,
    proceed: () => {
      if (waiting === null) return;
      const next = waiting;
      waiting = null;
      here = next;
      window.location.hash = next;
      notify();
    },
    reset: () => {
      waiting = null;
      notify();
    },
  };
}

export const hashNavigation: Navigation = { Link, usePathname, useBlocker };
