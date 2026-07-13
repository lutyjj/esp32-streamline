import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { Chip } from '../src/components/Chip';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('Chip', () => {
  it('is neutral with no tone class and no dot by default', () => {
    const host = mount(<Chip>v1.2.3</Chip>);
    const chip = host.querySelector('.chip');
    expect(chip?.className).toBe('chip');
    expect(chip?.textContent).toBe('v1.2.3');
    expect(host.querySelector('.statusdot')).toBeNull();
  });

  it('carries the tone on both the chip and its dot', () => {
    const host = mount(
      <Chip tone="good" dot>
        connected
      </Chip>,
    );
    expect(host.querySelector('.chip.good')).not.toBeNull();
    expect(host.querySelector('.statusdot.good')).not.toBeNull();
  });

  it('leaves a neutral dot free of a tone class', () => {
    const host = mount(<Chip dot>idle</Chip>);
    expect(host.querySelector('.statusdot')?.className.trim()).toBe('statusdot');
  });
});
