import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disclosure } from '../src/components/Disclosure';

function summary(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.disclosure-summary');
  if (!button) throw new Error('missing disclosure summary');
  return button;
}

describe('Disclosure', () => {
  it('manages its own state when uncontrolled', () => {
    const host = document.createElement('div');
    render(
      <Disclosure title="Details">
        <p>body</p>
      </Disclosure>,
      host,
    );

    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('body');

    act(() => summary(host).click());
    expect(host.textContent).toContain('body');
  });

  it('follows the parent in controlled mode and reports toggles', () => {
    const opens: boolean[] = [];
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" id="external" onClick={() => setOpen(true)}>
            expand externally
          </button>
          <Disclosure
            title="Details"
            open={open}
            onToggle={(next) => {
              opens.push(next);
              setOpen(next);
            }}
          >
            <p>body</p>
          </Disclosure>
        </>
      );
    }
    const host = document.createElement('div');
    render(<Harness />, host);

    expect(host.textContent).not.toContain('body');

    act(() => host.querySelector<HTMLButtonElement>('#external')?.click());
    expect(host.textContent).toContain('body');

    act(() => summary(host).click());
    expect(opens).toEqual([false]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('settled overflow lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function root(host: HTMLElement): HTMLElement {
    const el = host.querySelector<HTMLElement>('.disclosure');
    if (!el) throw new Error('missing disclosure root');
    return el;
  }

  it('frees overflow only after the opening animation settles', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    render(
      <Disclosure title="Details">
        <p>body</p>
      </Disclosure>,
      host,
    );

    act(() => summary(host).click());
    // Animating open: content mounted, still clipping.
    expect(host.textContent).toContain('body');
    expect(root(host).classList.contains('settled')).toBe(false);

    // Reduced-motion path: no transitionend ever fires, the timer settles.
    act(() => void vi.advanceTimersByTime(200));
    expect(root(host).classList.contains('settled')).toBe(true);
  });

  it('mounts an initially open disclosure settled and reclips when closing starts', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    render(
      <Disclosure title="Details" defaultOpen>
        <p>body</p>
      </Disclosure>,
      host,
    );
    // No animation runs on first paint, so an open mount is already at rest.
    expect(root(host).classList.contains('settled')).toBe(true);

    act(() => summary(host).click());
    expect(root(host).classList.contains('settled')).toBe(false);
    // The panel unmounts after the close animation window.
    act(() => void vi.advanceTimersByTime(200));
    expect(host.textContent).not.toContain('body');
  });
});
