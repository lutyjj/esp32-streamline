import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { MeterRow } from '../src/components/Meter';
import { meterPct } from '../src/lib/format';

describe('MeterRow', () => {
  it('exposes the level as an accessible meter value', () => {
    const host = document.createElement('div');
    render(<MeterRow label="L" rms={0.1} peak={0.2} />, host);

    const track = host.querySelector('[role=meter]');
    expect(track?.getAttribute('aria-label')).toBe('L level');
    expect(track?.getAttribute('aria-valuenow')).toBe(String(Math.round(meterPct(0.1))));
    expect(track?.getAttribute('aria-valuetext')).toContain('dBFS');
  });
});
