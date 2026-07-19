import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { ButtonControls } from '../src/components/ButtonControls';
import type { ButtonCapabilityStatus } from '../src/lib/api';

const key1: ButtonCapabilityStatus = {
  id: 'key1',
  label: 'Key 1',
  gpio: 36,
  active_low: true,
  default_action: 'toggle_stream',
};

const select = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('.buttonrow select');

describe('ButtonControls', () => {
  it('is absent when the board wires no buttons', () => {
    const host = document.createElement('div');
    render(<ButtonControls buttons={[]} actions={[]} writable provisioned />, host);
    expect(host.textContent).toBe('');
  });

  it('shows one control per button, set to its effective action', () => {
    const host = document.createElement('div');
    render(
      <ButtonControls
        buttons={[key1]}
        actions={[{ id: 'key1', action: 'cycle_input' }]}
        writable
        provisioned
      />,
      host,
    );
    expect(host.textContent).toContain('Key 1');
    expect(host.textContent).toContain('Selects the next input line');
    expect(select(host)?.value).toBe('cycle_input');
    const options = [...(select(host)?.options ?? [])].map((option) => option.value);
    expect(options).toEqual(['none', 'toggle_stream', 'cycle_input', 'restart', 'factory_reset']);
  });

  it('warns that a destructive action fires on one press', () => {
    const host = document.createElement('div');
    render(
      <ButtonControls
        buttons={[key1]}
        actions={[{ id: 'key1', action: 'factory_reset' }]}
        writable
        provisioned
      />,
      host,
    );
    expect(host.querySelector('.buttonrow-sub.warn')?.textContent).toContain(
      'one press, no confirmation',
    );
  });

  it('locks the control until the device is writable', () => {
    const host = document.createElement('div');
    render(
      <ButtonControls
        buttons={[key1]}
        actions={[{ id: 'key1', action: 'none' }]}
        writable={false}
        provisioned
      />,
      host,
    );
    expect(select(host)?.disabled).toBe(true);
  });

  it('locks and explains that button control waits for setup to finish', () => {
    const host = document.createElement('div');
    render(
      <ButtonControls
        buttons={[key1]}
        actions={[{ id: 'key1', action: 'none' }]}
        writable
        provisioned={false}
      />,
      host,
    );
    expect(select(host)?.disabled).toBe(true);
    expect(host.textContent).toContain('available after setup completes');
  });
});
