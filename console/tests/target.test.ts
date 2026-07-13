import { describe, expect, it } from 'vitest';
import { normalizeTargetHost } from '../src/lib/target';

// Stage 3: host and port are one form, but the device stores them apart. The
// Network tab rejects a host that carries its own port, scheme, or path so the
// save cannot land a value the device would misparse.
describe('normalizeTargetHost', () => {
  it('accepts a bare hostname or IP and trims surrounding space', () => {
    expect(normalizeTargetHost('  bridge.local ')).toBe('bridge.local');
    expect(normalizeTargetHost('192.0.2.10')).toBe('192.0.2.10');
    expect(normalizeTargetHost('')).toBe('');
  });

  it('rejects a host that smuggles in a port, scheme, or path', () => {
    expect(() => normalizeTargetHost('bridge.local:39000')).toThrow(/port, scheme, or path/);
    expect(() => normalizeTargetHost('http://bridge.local')).toThrow(/port, scheme, or path/);
    expect(() => normalizeTargetHost('bridge.local/stream')).toThrow(/port, scheme, or path/);
  });
});
