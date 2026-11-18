import { describe, expect, it } from 'vitest';
import { bytes, dbfs, duration, LEVEL_FLOOR_DB, levelDb, levelText } from '../../src/shared/format';

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

  it('reads the loudest peak under the clip threshold as 0.0, without a sign', () => {
    expect(dbfs(32759)).toBe('0.0');
  });
});

describe('levelText', () => {
  it('reads the floor as silent', () => {
    expect(levelText(LEVEL_FLOOR_DB)).toBe('silent');
  });

  it('reads the clip threshold as 0.0 dB, without a sign', () => {
    expect(levelText(levelDb(32760))).toBe('0.0 dB');
  });

  it('reads a level below full scale to a tenth', () => {
    expect(levelText(levelDb(16384))).toBe('-6.0 dB');
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

describe('levelDb', () => {
  it('reads full scale as 0 and holds silence and quiet input to the floor', () => {
    expect(levelDb(32768)).toBe(0);
    expect(levelDb(16384)).toBeCloseTo(-6.02, 2);
    expect(levelDb(0)).toBe(LEVEL_FLOOR_DB);
    expect(levelDb(1)).toBe(LEVEL_FLOOR_DB);
  });
});
