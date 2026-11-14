import { describe, expect, it } from 'vitest';
import type { StatusResponse } from '../src/lib/api';
import { deviceStatus } from '../src/mocks/fixtures';
import { recoveryStory } from '../src/state/recovery';

function recovering(joinFailure: StatusResponse['wifi']['join_failure']): StatusResponse {
  return deviceStatus({
    mode: 'recovery',
    wifi: { ssid: 'Study Wi-Fi', status: 'ap', ap_ip: '192.168.71.1', join_failure: joinFailure },
  });
}

describe('recoveryStory', () => {
  it('tells nothing outside recovery, first-run setup included', () => {
    expect(recoveryStory(deviceStatus(), false)).toBeNull();
    expect(recoveryStory(deviceStatus({ mode: 'setup' }), true)).toBeNull();
    expect(recoveryStory(null, true)).toBeNull();
  });

  it('promises the rejoin when the network is merely gone', () => {
    const story = recoveryStory(recovering('network-not-found'), false);
    expect(story?.kind).toBe('retrying');
    expect(story?.text).toContain('can’t find Study Wi-Fi');
    expect(story?.text).toContain('rejoins on its own');
  });

  it('asks for the new password when the network refuses the saved one', () => {
    const story = recoveryStory(recovering('credentials-rejected'), false);
    expect(story?.text).toContain('Study Wi-Fi didn’t accept the saved password');
    expect(story?.text).toContain('enter the new one');
    expect(story?.text).not.toContain('rejoins on its own');
  });

  it('claims no cause it was not told', () => {
    for (const failure of ['other', null] as const) {
      expect(recoveryStory(recovering(failure), false)?.text).toContain('can’t join Study Wi-Fi');
    }
  });

  it('sends a browser that lost the setup network to the home address', () => {
    // The setup network closes when the device restarts onto its home network,
    // so this browser loses contact; that is the expected end of recovery.
    const story = recoveryStory(recovering('network-not-found'), true);
    expect(story?.kind).toBe('left');
    // A failed poll alone does not prove the rejoin, so the claim stays conditional.
    expect(story?.text).toContain('If its setup network is gone');
    expect(story?.text).toContain('reconnect to Study Wi-Fi');
    expect(story?.text).toContain('http://streamline-0000.local/');
  });
});
