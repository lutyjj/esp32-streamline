import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { LockChip } from '../src/components/LockChip';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('LockChip', () => {
  it('reflects the state and the how-to-change hint', () => {
    const host = mount(
      <LockChip state="locked" text="Locked" sub="· click to unlock" onClick={() => {}} />,
    );
    const button = host.querySelector('button.lockchip');
    expect(button?.className).toContain('locked');
    expect(button?.textContent).toContain('Locked');
    expect(host.querySelector('small')?.textContent).toBe('· click to unlock');
  });

  it('drops the state class when neutral and omits an empty hint', () => {
    const host = mount(<LockChip state="neutral" text="Checking…" onClick={() => {}} />);
    expect(host.querySelector('button.lockchip')?.className.trim()).toBe('lockchip');
    expect(host.querySelector('small')).toBeNull();
  });

  it('toggles on click', () => {
    const onClick = vi.fn();
    const host = mount(<LockChip state="unlocked" text="Unlocked" onClick={onClick} />);
    host.querySelector('button')?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
