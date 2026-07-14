import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { AnalogPassthrough } from '../src/components/AnalogPassthrough';

const off = { enabled: false, active: false, fault: null };

describe('AnalogPassthrough', () => {
  it('is absent when the selected board does not advertise the route', () => {
    const host = document.createElement('div');
    render(<AnalogPassthrough status={off} writable provisioned />, host);

    expect(host.textContent).toBe('');
  });

  it('offers one switch that names the jack and its limits, with no duplicate status', () => {
    const host = document.createElement('div');
    render(
      <AnalogPassthrough
        capability={{ output_line: 2, label: '3.5 mm output' }}
        status={{ enabled: true, active: true, fault: null }}
        writable
        provisioned
      />,
      host,
    );

    const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(false);
    expect(host.textContent).toContain('Analog passthrough');
    expect(host.textContent).toContain('3.5 mm output');
    expect(host.textContent).toContain('direct analog path');
    expect(host.textContent).toContain('fixed line level');
    expect(host.textContent).toContain('apply immediately');
    // The switch is the state; no separate Output route legend or chip.
    expect(host.textContent).not.toContain('Output route');
    expect(host.textContent).not.toContain('Active');
    expect(host.querySelector('.chip')).toBeNull();
  });

  it('names a live codec fault and how to leave it', () => {
    const host = document.createElement('div');
    render(
      <AnalogPassthrough
        capability={{ output_line: 2, label: 'output jack' }}
        status={{ enabled: true, active: false, fault: 'codec write failed' }}
        writable
        provisioned
      />,
      host,
    );

    expect(host.textContent).toContain('codec write failed');
    expect(host.textContent).toContain('Turn analog passthrough off, then on again to retry.');
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true);
  });

  it('offers a retry after a failed off command', () => {
    const host = document.createElement('div');
    render(
      <AnalogPassthrough
        capability={{ output_line: 2, label: 'output jack' }}
        status={{ enabled: false, active: false, fault: 'power-down failed' }}
        writable
        provisioned
      />,
      host,
    );

    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    expect(host.textContent).toContain('Turn analog passthrough on to retry.');
  });
});
