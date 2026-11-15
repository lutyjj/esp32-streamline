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
  text: string;
  /** The one act that answers it. */
  action?: 'change-wifi';
}

export const OVERDUE_TEXT =
  'Still offline after a minute. The device may have fallen back to its setup network; look for esp32-streamline-… in your Wi-Fi list.';

export function deviceNotice(connection: Connection): DeviceNotice | null {
  if (connection.phase === 'opening' || connection.phase === 'handoff') return null;
  const last = connection.seen?.status ?? null;
  // From the setup network, an absence most likely means the device rejoined
  // its own network, which this browser cannot see.
  const fromRecovery = last?.mode === 'recovery';
  switch (connection.phase) {
    case 'live': {
      const story = recoveryStory(last, false);
      return story && { tone: 'attention', text: story.text, action: 'change-wifi' };
    }
    case 'waiting':
      return {
        tone: 'progress',
        text: `Restarting to apply ${connection.operation}. The console reconnects once the device answers from its new start.`,
      };
    case 'overdue':
    case 'lost':
      if (fromRecovery) {
        return { tone: 'attention', text: recoveryStory(last, true)?.text ?? '' };
      }
      return connection.phase === 'overdue'
        ? { tone: 'attention', text: OVERDUE_TEXT }
        : {
            tone: 'failure',
            text: 'The device is not answering, so live values are unavailable. The console keeps trying.',
          };
  }
}
