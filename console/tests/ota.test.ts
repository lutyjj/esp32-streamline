import { describe, expect, it } from 'vitest';
import { updateRecovery } from '../src/state/ota';

describe('updateRecovery', () => {
  it('is applied when the version advanced to the release we aimed for', () => {
    expect(updateRecovery('0.4.0', '0.5.0', '0.5.0')).toBe('applied');
  });

  it('is applied when a custom image booted a different version', () => {
    // No expected release, but the version changed, so the new image is running.
    expect(updateRecovery('0.4.0', '', '0.4.1-dev')).toBe('applied');
  });

  it('is rolled back when a newer release was aimed for but the old version returned', () => {
    // The bootloader reverted: the version that ran the install came back.
    expect(updateRecovery('0.4.0', '0.5.0', '0.4.0')).toBe('rolled-back');
  });

  it('is inconclusive when a same-version custom image returns', () => {
    // A reinstall and a revert look identical without a version change.
    expect(updateRecovery('0.4.0', '', '0.4.0')).toBe('inconclusive');
  });
});
