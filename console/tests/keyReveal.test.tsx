import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { KeyReveal } from '../src/components/KeyReveal';
import { RememberSwitch } from '../src/components/RememberSwitch';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('KeyReveal', () => {
  it('shows the secret and offers remember and copy', () => {
    const host = mount(<KeyReveal secret="abc123" remember={true} onRemember={() => {}} />);
    expect(host.querySelector('.keyblock')?.textContent).toBe('abc123');
    expect(host.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(host.querySelector('button')?.textContent).toContain('Copy key');
  });

  it('keeps copy and remember usable regardless of lock state', () => {
    // The secret is already on screen; copying it and choosing custody are
    // local actions, so an expiring unlock window cannot brick them.
    const host = mount(<KeyReveal secret="abc123" remember={false} onRemember={() => {}} />);
    expect(host.querySelector('input')?.disabled).toBe(false);
    expect(host.querySelector('button')?.disabled).toBe(false);
  });
});

describe('RememberSwitch', () => {
  it('reports the new checked state on toggle', () => {
    const onChange = vi.fn();
    const host = mount(<RememberSwitch checked={false} onChange={onChange} />);
    const input = host.querySelector('input');
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
