import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StatusResponse, setTransport } from '../src/lib/api';
import { deviceStatus } from '../src/mocks/fixtures';
import { refresh, status, unreachable } from '../src/state/device';
import { beginRebootWait, REBOOT_WARN_POLLS, rebootWait } from '../src/state/rebootWait';
import { recovery, recoveryStory } from '../src/state/recovery';
import { toasts } from '../src/state/toasts';

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

  it('asks to recheck the password choice when the security does not match', () => {
    const story = recoveryStory(recovering('security-mismatch'), false);
    expect(story?.text).toContain('Study Wi-Fi doesn’t accept the security saved for it');
    expect(story?.text).toContain('a security mode StreamLine can’t join');
    expect(story?.text).toContain('update the saved details');
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

describe('a reboot from recovery', () => {
  afterEach(() => {
    status.value = null;
    unreachable.value = false;
    rebootWait.value = null;
    toasts.value = [];
    setTransport((request) => fetch(request));
  });

  it('that stays away names the home address, and a late return still completes it', async () => {
    // The device restarted onto its home network, so the setup network is gone.
    status.value = recovering('network-not-found');
    setTransport(async () => {
      throw new TypeError('setup network gone');
    });
    beginRebootWait('the restart');
    toasts.value = [];

    for (let poll = 0; poll < REBOOT_WARN_POLLS; poll += 1) await refresh();

    expect(recovery.value?.kind).toBe('left');
    expect(recovery.value?.text).toContain('http://streamline-0000.local/');
    expect(toasts.value.map((entry) => entry.text).join(' ')).not.toContain('setup network');

    // The saved network was still down after all: the device is back in recovery.
    const reads: string[] = [];
    setTransport(async (request) => {
      reads.push(new URL(request.url).pathname);
      return new Response(JSON.stringify(recovering('network-not-found')), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await refresh();

    expect(rebootWait.value).toBeNull();
    expect(unreachable.value).toBe(false);
    expect(toasts.value.map((entry) => entry.text)).toContain('Back online — the restart applied');
    // A completed wait re-reads the settings the reboot applied.
    await vi.waitFor(() => expect(reads).toContain('/api/settings'));
  });
});
