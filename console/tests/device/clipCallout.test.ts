import { beforeEach, describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  clipCalloutVisible,
  clipDismissed,
  dismissClipCallout,
} from '../../src/device/state/clipCallout';
import { answering } from './answering';

function withClips(clips: number, mode: 'setup' | 'provisioned' = 'provisioned') {
  return deviceStatus({ mode, metrics: { clipped_samples_total: clips } });
}

beforeEach(() => {
  answering(null);
  clipDismissed.value = false;
});

describe('clip callout', () => {
  it('stays hidden without status, in setup mode, and with zero clips', () => {
    expect(clipCalloutVisible.value).toBe(false);
    answering(withClips(120, 'setup'));
    expect(clipCalloutVisible.value).toBe(false);
    answering(withClips(0));
    expect(clipCalloutVisible.value).toBe(false);
  });

  it('shows once clipping is recorded on a provisioned device', () => {
    answering(withClips(1));
    expect(clipCalloutVisible.value).toBe(true);
  });

  it('dismiss hides it, and it stays hidden while the counter grows', () => {
    answering(withClips(100));
    dismissClipCallout();
    expect(clipCalloutVisible.value).toBe(false);
    answering(withClips(150));
    expect(clipCalloutVisible.value).toBe(false);
  });

  it('re-arms after the counter resets, when the levels were re-set', () => {
    answering(withClips(100));
    dismissClipCallout();
    answering(withClips(0));
    expect(clipCalloutVisible.value).toBe(false);
    answering(withClips(3));
    expect(clipCalloutVisible.value).toBe(true);
  });
});
