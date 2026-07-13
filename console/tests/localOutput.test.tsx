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

  it('offers streaming-only and simultaneous local-output routes', () => {
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

    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(host.textContent).toContain('Output route');
    expect(host.textContent).toContain('Streaming only');
    expect(host.textContent).toContain('Streaming + local output');
    expect(host.textContent).toContain('3.5 mm output');
    expect(host.textContent).toContain('direct analog path');
    expect(host.textContent).toContain('Route changes apply immediately');
    expect(host.textContent).toContain('selected source feeds both paths');
    expect(host.textContent).toContain('fixed at line level');
    expect(host.textContent).toContain('Active');
    expect(host.textContent).not.toContain('volume control');
  });

  it('names a live codec fault and offers the off route', () => {
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
    expect(host.textContent).toContain('Choose Streaming only to turn the route off');
    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
  });

  it('leaves both routes unselected so a failed off command can be retried', () => {
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

    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(false);
    expect(host.textContent).toContain('Choose Streaming only to retry');
  });
});
