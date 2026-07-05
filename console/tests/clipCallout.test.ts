import { beforeEach, describe, expect, it } from 'vitest';
import { clipCalloutVisible, clipDismissed, dismissClipCallout } from '../src/state/clipCallout';
import { status } from '../src/state/device';
import { deviceStatus } from './fixtures';

function withClips(clips: number, mode: 'setup' | 'provisioned' = 'provisioned') {
  return deviceStatus({ mode, metrics: { clipped_samples_total: clips } });
}

beforeEach(() => {
  status.value = null;
  clipDismissed.value = false;
});

describe('clip callout', () => {
  it('stays hidden without status, in setup mode, and with zero clips', () => {
    expect(clipCalloutVisible.value).toBe(false);
    status.value = withClips(120, 'setup');
    expect(clipCalloutVisible.value).toBe(false);
    status.value = withClips(0);
    expect(clipCalloutVisible.value).toBe(false);
  });

  it('shows once clipping is recorded on a provisioned device', () => {
    status.value = withClips(1);
    expect(clipCalloutVisible.value).toBe(true);
  });

  it('dismiss hides it, and it stays hidden while the counter grows', () => {
    status.value = withClips(100);
    dismissClipCallout();
    expect(clipCalloutVisible.value).toBe(false);
    status.value = withClips(150);
    expect(clipCalloutVisible.value).toBe(false);
  });

  it('re-arms after the counter resets, when the levels were re-set', () => {
    status.value = withClips(100);
    dismissClipCallout();
    status.value = withClips(0);
    expect(clipCalloutVisible.value).toBe(false);
    status.value = withClips(3);
    expect(clipCalloutVisible.value).toBe(true);
  });
});
