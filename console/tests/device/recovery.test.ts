import { QueryObserver } from '@tanstack/preact-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { OVERDUE_MS } from '../../src/device/state/connection';
import { connection, report, restartSettled } from '../../src/device/state/device';
import { queryClient, settingsQuery } from '../../src/device/state/queries';
import { recovery, recoveryStory } from '../../src/device/state/recovery';
import type { StatusResponse } from '../../src/generated/api';
import { answering } from './answering';

/** Everything a story says, title and description together. */
function said(story: { title: string; description?: string } | null | undefined): string {
  return story ? `${story.title} ${story.description ?? ''}` : '';
}

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
    expect(said(story)).toContain('can’t find Study Wi-Fi');
    expect(said(story)).toContain('rejoins on its own');
  });

  it('asks for the new password when the network refuses the saved one', () => {
    const story = recoveryStory(recovering('credentials-rejected'), false);
    expect(said(story)).toContain('Study Wi-Fi didn’t accept the saved password');
    expect(said(story)).toContain('enter the new one');
    expect(said(story)).not.toContain('rejoins on its own');
  });

  it('asks to recheck the password choice when the security does not match', () => {
    const story = recoveryStory(recovering('security-mismatch'), false);
    expect(said(story)).toContain('Study Wi-Fi doesn’t accept the security saved for it');
    expect(said(story)).toContain('a security mode StreamLine can’t join');
    expect(said(story)).toContain('update the saved details');
    expect(said(story)).not.toContain('rejoins on its own');
  });

  it('claims no cause it was not told', () => {
    for (const failure of ['other', null] as const) {
      expect(said(recoveryStory(recovering(failure), false))).toContain('can’t join Study Wi-Fi');
    }
  });

  it('sends a browser that lost the setup network to the home address', () => {
    // The setup network closes when the device restarts onto its home network,
    // so this browser loses contact; that is the expected end of recovery.
    const story = recoveryStory(recovering('network-not-found'), true);
    expect(story?.kind).toBe('left');
    // A failed poll alone does not prove the rejoin, so the claim stays conditional.
    expect(said(story)).toContain('If its setup network is gone');
    expect(said(story)).toContain('reconnect to Study Wi-Fi');
    expect(said(story)).toContain('http://streamline-0000.local/');
  });
});

describe('a restart from recovery', () => {
  afterEach(() => {
    answering(null);
    restartSettled.value = null;
    setTransport((request) => fetch(request));
  });

  it('that stays away names the home address, and a late return still finishes it', async () => {
    const before = recovering('network-not-found');
    report({ type: 'answered', status: before, at: 0 });
    report({ type: 'restarting', operation: 'the restart', at: 1000 });
    // The device restarted onto its home network, so the setup network is gone.
    report({ type: 'unanswered', at: 1000 + OVERDUE_MS });

    expect(connection.value.phase).toBe('overdue');
    expect(recovery.value?.kind).toBe('left');
    expect(said(recovery.value)).toContain('http://streamline-0000.local/');

    // The saved network was still down after all: a new boot answers in recovery.
    const shown = new QueryObserver(queryClient, settingsQuery).subscribe(() => undefined);
    const reads: string[] = [];
    setTransport(async (request) => {
      reads.push(new URL(request.url).pathname);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const after = { ...before, system: { ...before.system, boot: before.system.boot + 1 } };
    report({ type: 'answered', status: after, at: 2000 + OVERDUE_MS });

    expect(connection.value.phase).toBe('live');
    expect(recovery.value?.kind).toBe('retrying');
    expect(restartSettled.value).toMatchObject({
      operation: 'the restart',
      after: { mode: 'recovery' },
    });
    // A finished restart re-reads the settings it applied, where they are shown.
    await vi.waitFor(() => expect(reads).toContain('/api/settings'));
    shown();
  });
});
