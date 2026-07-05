import { describe, expect, it } from 'vitest';
import { dbfs, meterPct } from '../src/lib/format';

describe('dbfs', () => {
  it('reads silence as -inf', () => {
    expect(dbfs(0)).toBe('-inf');
  });

  it('reads full scale as 0.0', () => {
    expect(dbfs(32768)).toBe('0.0');
  });

  it('reads half scale as -6.0', () => {
    expect(dbfs(16384)).toBe('-6.0');
  });
});

describe('meterPct', () => {
  it('pins silence to the left edge', () => {
    expect(meterPct(0)).toBe(0);
  });

  it('pins full scale to the right edge', () => {
    expect(meterPct(32768)).toBe(100);
  });

  it('clamps signals below the -60 dBFS floor', () => {
    expect(meterPct(1)).toBe(0);
  });
});
