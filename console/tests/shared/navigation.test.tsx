import { act } from 'preact/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashNavigation,
  hashPath,
  Link,
  replacePath,
  usePathname,
} from '../../src/shared/navigation';

let host: HTMLDivElement;
let root: Root;
/** The blocker the page under test holds, and whether it holds. */
let blocker: ReturnType<NonNullable<typeof hashNavigation.useBlocker>> | undefined;
let holding = false;

function Page() {
  const path = usePathname();
  blocker = hashNavigation.useBlocker?.((next) => holding && next !== path);
  return (
    <>
      <output>{path}</output>
      <Link href="/bridge">Bridge</Link>
    </>
  );
}

const shown = () => host.querySelector('output')?.textContent;
const link = () => host.querySelector('a') as HTMLAnchorElement;

beforeEach(() => {
  replacePath('/audio');
  holding = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Page />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('hashPath', () => {
  it('reads the path inside the hash, and anything else as the root', () => {
    expect(hashPath('#/device/wifi')).toBe('/device/wifi');
    expect(hashPath('')).toBe('/');
    expect(hashPath('#section')).toBe('/');
  });
});

describe('hash navigation', () => {
  it('links into the hash and moves on a click', async () => {
    expect(link().getAttribute('href')).toBe('#/bridge');
    act(() => link().click());
    await vi.waitFor(() => expect(shown()).toBe('/bridge'));
    expect(window.location.hash).toBe('#/bridge');
  });

  it('holds a link while a draft holds the move, then lets it go on', async () => {
    holding = true;
    act(() => link().click());
    expect(blocker?.blocked).toBe(true);
    expect(shown()).toBe('/audio');
    expect(window.location.hash).toBe('#/audio');
    act(() => blocker?.proceed());
    await vi.waitFor(() => expect(shown()).toBe('/bridge'));
    expect(blocker?.blocked).toBe(false);
  });

  it('calls a held move off, staying where it was', () => {
    holding = true;
    act(() => link().click());
    act(() => blocker?.reset());
    expect(blocker?.blocked).toBe(false);
    expect(shown()).toBe('/audio');
  });

  it('puts the address back when Back or Forward moves it during a hold', async () => {
    holding = true;
    act(() => {
      window.location.hash = '#/maintenance';
    });
    await vi.waitFor(() => expect(blocker?.blocked).toBe(true));
    expect(window.location.hash).toBe('#/audio');
    expect(shown()).toBe('/audio');
  });
});
