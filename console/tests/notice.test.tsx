import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../src/components/EmptyState';
import { Notice } from '../src/components/Notice';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('Notice', () => {
  it('defaults to info with no tone class', () => {
    const host = mount(<Notice>Heads up</Notice>);
    expect(host.querySelector('.notice')?.className).toBe('notice');
  });

  it('applies the error and warn tones', () => {
    expect(mount(<Notice tone="error">Boom</Notice>).querySelector('.notice.error')).not.toBeNull();
    expect(mount(<Notice tone="warn">Wait</Notice>).querySelector('.notice.warn')).not.toBeNull();
  });
});

describe('EmptyState', () => {
  it('renders its children in a placeholder', () => {
    const host = mount(<EmptyState>Nothing here yet</EmptyState>);
    expect(host.querySelector('.empty')?.textContent).toBe('Nothing here yet');
  });
});
