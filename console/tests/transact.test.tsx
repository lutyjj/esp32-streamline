import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { ActionState, TransactButton } from '../src/components/Transact';
import type { Transact } from '../src/lib/hooks';

function transactWith(busy: boolean, state: Transact['state'] = { text: '', cls: '' }): Transact {
  return { busy, state, setState: () => {}, run: async () => {} };
}

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('TransactButton', () => {
  it('disables itself and shows the busy state while the transaction runs', () => {
    const host = mount(<TransactButton transact={transactWith(true)}>Save</TransactButton>);
    const button = host.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.className).toContain('busy');
  });

  it('honors external gates such as locked settings', () => {
    const host = mount(
      <TransactButton transact={transactWith(false)} disabled>
        Save
      </TransactButton>,
    );
    expect(host.querySelector('button')?.disabled).toBe(true);
  });

  it('fires onClick when idle and unlocked', () => {
    const onClick = vi.fn();
    const host = mount(
      <TransactButton transact={transactWith(false)} onClick={onClick}>
        Save
      </TransactButton>,
    );
    host.querySelector('button')?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ActionState', () => {
  it('renders the result text with its severity class', () => {
    const host = mount(<ActionState state={{ text: 'unauthorized', cls: 'err' }} />);
    const span = host.querySelector('span');
    expect(span?.textContent).toBe('unauthorized');
    expect(span?.className).toContain('err');
  });
});
