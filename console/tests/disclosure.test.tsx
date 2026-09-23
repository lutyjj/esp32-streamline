import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
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

it('preserves a field draft while collapsed and links its accessible control', () => {
  const host = document.createElement('div');
  render(
    <Disclosure title="Details" defaultOpen>
      <input aria-label="Draft" />
    </Disclosure>,
    host,
  );
  const field = host.querySelector('input');
  if (!field) throw new Error('missing draft');
  field.value = 'unfinished';
  const panel = host.querySelector<HTMLDivElement>('.disclosure-panel');
  expect(summary(host).getAttribute('aria-controls')).toBe(panel?.id);
  act(() => summary(host).click());
  expect(panel?.hidden).toBe(true);
  act(() => summary(host).click());
  expect(host.querySelector('input')?.value).toBe('unfinished');
  expect(panel?.hidden).toBe(false);
});
