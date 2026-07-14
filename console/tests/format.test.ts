import { describe, expect, it } from 'vitest';
import { bytes, dbfs, duration, meterPct, usagePct, usageTone } from '../src/lib/format';

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

describe('bytes', () => {
  it('shows raw bytes below a kilobyte', () => {
    expect(bytes(512)).toBe('512 B');
  });

  it('rounds to whole kilobytes in the heap range', () => {
    expect(bytes(126_488)).toBe('124 KB');
    expect(bytes(323_100)).toBe('316 KB');
  });

  it('shows one decimal megabyte past a mebibyte', () => {
    expect(bytes(1_992_294)).toBe('1.9 MB');
  });

  it('rolls the kilobyte boundary into megabytes rather than 1024 KB', () => {
    expect(bytes(1_048_575)).toBe('1.0 MB');
  });
});

describe('duration', () => {
  it('shows seconds under a minute', () => {
    expect(duration(45)).toBe('45s');
  });

  it('shows minutes and seconds under an hour', () => {
    expect(duration(320)).toBe('5m 20s');
  });

  it('shows hours and minutes under a day', () => {
    expect(duration(7_500)).toBe('2h 5m');
  });

  it('shows days and hours beyond a day', () => {
    expect(duration(273_600)).toBe('3d 4h');
  });

  it('never renders a negative uptime', () => {
    expect(duration(-5)).toBe('0s');
  });
});

describe('usagePct', () => {
  it('computes the fraction in use', () => {
    expect(usagePct(275, 756)).toBeCloseTo(36.4, 1);
  });

  it('clamps an over-full value to 100', () => {
    expect(usagePct(800, 756)).toBe(100);
  });

  it('guards a zero total instead of dividing by zero', () => {
    expect(usagePct(100, 0)).toBe(0);
  });
});

describe('usageTone', () => {
  it('is comfortable with headroom to spare', () => {
    expect(usageTone(36)).toBe('good');
  });

  it('warns once the resource is mostly used', () => {
    expect(usageTone(80)).toBe('warn');
    expect(usageTone(94.9)).toBe('warn');
  });

  it('flags critical near full', () => {
    expect(usageTone(95)).toBe('bad');
    expect(usageTone(100)).toBe('bad');
  });
});
