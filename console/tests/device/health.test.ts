import { beforeEach, describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { blockingHealth } from '../../src/device/state/health';
import type { HealthReport } from '../../src/generated/api';
import { answering } from './answering';

const blocking: HealthReport = {
  status: 'blocking',
  checks: [
    {
      id: 'codec',
      status: 'fail',
      severity: 'blocking',
      detail: 'Audio hardware did not initialize.',
      remedy: 'Check the board descriptor and wiring, then restart.',
      fixable: true,
    },
  ],
};

beforeEach(() => {
  answering(null);
});

describe('blockingHealth', () => {
  it('is null before any status arrives', () => {
    expect(blockingHealth.value).toBeNull();
  });

  it('is null when the startup verdict is clean', () => {
    answering(deviceStatus());
    expect(blockingHealth.value).toBeNull();
  });

  it('surfaces the blocking check with its remedy on a provisioned device', () => {
    answering(deviceStatus({ health: blocking }));
    const fault = blockingHealth.value;
    expect(fault?.id).toBe('codec');
    expect(fault?.remedy).toContain('board descriptor');
  });

  it('stays quiet in setup mode, where there is nothing to check yet', () => {
    // A commissioning device shows onboarding, not a fault banner.
    answering(deviceStatus({ mode: 'setup', health: blocking }));
    expect(blockingHealth.value).toBeNull();
  });
});
