import { describe, expect, it } from 'vitest';
import { deviceStatus, setupNetwork } from '../../src/device/mocks/fixtures';
import { connection } from '../../src/device/state/device';
import { beginResetHandoff, handoffStory } from '../../src/device/state/handoff';
import { SETUP_ADDRESS } from '../../src/shared/setupNetwork';

describe('handoffStory', () => {
  it('sends a joined browser to the home address and says how a failed join shows', () => {
    const story = handoffStory({ kind: 'join', ssid: 'studio', confirmed: true }, deviceStatus());
    expect(story.title).toBe('Joining studio');
    expect(story.text).toContain('saved studio');
    expect(story.text).toContain('opens its setup network again');
    expect(story.address).toBe('http://streamline-0000.local/');
  });

  it('claims no save it did not see', () => {
    const story = handoffStory({ kind: 'join', ssid: 'studio', confirmed: false }, null);
    expect(story.text).toContain('before the device confirmed');
    expect(story.text).not.toContain('saved studio and');
    expect(story.address).toBe('http://streamline-xxxx.local/');
  });

  it('repeats the setup network a reset named, and names the way back without it', () => {
    const named = handoffStory({ kind: 'reset', setupNetwork: setupNetwork() }, null);
    expect(named.setupNetwork).toEqual(setupNetwork());
    expect(named.address).toBe(SETUP_ADDRESS);
    const unknown = handoffStory({ kind: 'reset', setupNetwork: null }, null);
    expect(unknown.setupNetwork).toBeUndefined();
    expect(unknown.text).toContain('label or serial log');
  });
});

describe('beginResetHandoff', () => {
  it('hands the connection off with whatever the reset response named', () => {
    beginResetHandoff();
    expect(connection.value).toMatchObject({
      phase: 'handoff',
      handoff: { kind: 'reset', setupNetwork: null },
    });
  });
});
