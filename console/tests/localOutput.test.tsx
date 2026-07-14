import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { LocalOutput } from '../src/components/LocalOutput';

const off = { enabled: false, active: false, fault: null };

describe('LocalOutput', () => {
  it('is absent when the selected board does not advertise the route', () => {
    const host = document.createElement('div');
    render(<LocalOutput status={off} writable provisioned />, host);

    expect(host.textContent).toBe('');
  });

  it('offers the local output as one switch that names the jack and its limits', () => {
    const host = document.createElement('div');
    render(
      <LocalOutput
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
    expect(host.textContent).toContain('Output route');
    expect(host.textContent).toContain('Local analog output');
    expect(host.textContent).toContain('3.5 mm output');
    expect(host.textContent).toContain('direct analog path');
    expect(host.textContent).toContain('fixed line level');
    expect(host.textContent).toContain('Changes apply immediately');
    expect(host.textContent).toContain('streaming only');
    expect(host.textContent).toContain('Active');
    expect(host.textContent).not.toContain('volume control');
  });

  it('names a live codec fault and how to leave it', () => {
    const host = document.createElement('div');
    render(
      <LocalOutput
        capability={{ output_line: 2, label: 'output jack' }}
        status={{ enabled: true, active: false, fault: 'codec write failed' }}
        writable
        provisioned
      />,
      host,
    );

    expect(host.textContent).toContain('Fault');
    expect(host.textContent).toContain('codec write failed');
    expect(host.textContent).toContain('Turn local output off, then on again to retry.');
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true);
  });

  it('offers a retry after a failed off command', () => {
    const host = document.createElement('div');
    render(
      <LocalOutput
        capability={{ output_line: 2, label: 'output jack' }}
        status={{ enabled: false, active: false, fault: 'power-down failed' }}
        writable
        provisioned
      />,
      host,
    );

    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    expect(host.textContent).toContain('Turn local output on to retry.');
  });
});
