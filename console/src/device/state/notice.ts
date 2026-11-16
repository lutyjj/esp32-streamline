/**
 * The page-wide notice: what every screen says while contact with the device
 * is anything but live, and while a device that lost its own network serves
 * this console from its setup network.
 */

import type { Connection } from './connection';
import { recoveryStory } from './recovery';

/** Work under way, a condition that wants a hand, or a failure. */
export type NoticeTone = 'progress' | 'attention' | 'failure';

export interface DeviceNotice {
  tone: NoticeTone;
  /** What holds, in one sentence. */
  title: string;
  description?: string;
  /** When it began, for a condition that counts how long it has held. */
  since?: number;
  /** The one act that answers it. */
  action?: 'change-wifi' | 'reload';
}

export const OVERDUE_DESCRIPTION =
  'The device may have fallen back to its setup network; look for esp32-streamline-… in your Wi-Fi list.';

export function deviceNotice(connection: Connection): DeviceNotice | null {
  if (connection.phase === 'opening' || connection.phase === 'handoff') return null;
  const last = connection.seen?.status ?? null;
  // From the setup network, an absence most likely means the device rejoined
  // its own network, which this browser cannot see.
  const fromRecovery = last?.mode === 'recovery';
  switch (connection.phase) {
    case 'live': {
      const story = recoveryStory(last, false);
      return (
        story && {
          tone: 'attention',
          title: story.title,
          description: story.description,
          action: 'change-wifi',
        }
      );
    }
    case 'waiting':
      return {
        tone: 'progress',
        title: `Waiting for ${connection.operation} to finish.`,
        description:
          'The device is restarting; the console reconnects once it answers from its new start.',
        since: connection.since,
      };
    case 'replaced':
      return {
        tone: 'attention',
        title: 'StreamLine runs other firmware now.',
        description: 'Reload to open the console it serves.',
        action: 'reload',
      };
    case 'overdue':
    case 'lost': {
      const story = fromRecovery ? recoveryStory(last, true) : null;
      if (story) return { tone: 'attention', title: story.title, description: story.description };
      return connection.phase === 'overdue'
        ? {
            tone: 'attention',
            title: 'Still restarting after a minute.',
            description: OVERDUE_DESCRIPTION,
            since: connection.since,
          }
        : {
            tone: 'failure',
            title: 'The device is not answering.',
            description: 'Live values are unavailable until it does. The console keeps trying.',
            since: connection.since,
          };
    }
  }
}
