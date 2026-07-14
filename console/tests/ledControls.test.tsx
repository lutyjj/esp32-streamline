import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { LedControls } from '../src/components/LedControls';
import type { LedCapabilityStatus } from '../src/lib/api';

const statusLed: LedCapabilityStatus = {
  id: 'status',
  label: 'Status light (D4)',
  gpio: 22,
  active_low: true,
  default_role: 'status',
};

const roleChoices = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLInputElement>('.segmented input[type="radio"]'),
];

describe('LedControls', () => {
  it('is absent when the board wires no LEDs', () => {
    const host = document.createElement('div');
    render(<LedControls leds={[]} roles={[]} writable provisioned />, host);
    expect(host.textContent).toBe('');
  });

  it('shows one control per LED, lit on its effective role', () => {
    const host = document.createElement('div');
    render(
      <LedControls
        leds={[statusLed]}
        roles={[{ id: 'status', role: 'off' }]}
        writable
        provisioned
      />,
      host,
    );
    expect(host.textContent).toContain('Status light (D4)');
    const choices = roleChoices(host);
    expect(choices.map((choice) => choice.value)).toEqual(['status', 'on', 'off']);
    expect(choices.find((choice) => choice.checked)?.value).toBe('off');
  });

  it('locks the control until the device is writable', () => {
    const host = document.createElement('div');
    render(
      <LedControls
        leds={[statusLed]}
        roles={[{ id: 'status', role: 'status' }]}
        writable={false}
        provisioned
      />,
      host,
    );
    expect(host.querySelector<HTMLFieldSetElement>('.segmented')?.disabled).toBe(true);
  });

  it('locks and explains that LED control waits for setup to finish', () => {
    const host = document.createElement('div');
    render(
      <LedControls
        leds={[statusLed]}
        roles={[{ id: 'status', role: 'status' }]}
        writable
        provisioned={false}
      />,
      host,
    );
    expect(host.querySelector<HTMLFieldSetElement>('.segmented')?.disabled).toBe(true);
    expect(host.textContent).toContain('available after setup completes');
  });
});
