import { Status, type StatusTone } from 'linen';
import type { AudioActivity } from '../state/activity';

/** What each activity is called, how it reads at a glance, and what it means for the owner. */
export const ACTIVITY: Record<
  AudioActivity,
  { word: string; tone: StatusTone; active?: boolean; meaning: string }
> = {
  opening: {
    word: 'Connecting',
    tone: 'unknown',
    meaning: 'Waiting for the device’s first answer.',
  },
  unavailable: {
    word: 'Unavailable',
    tone: 'unknown',
    meaning: 'Live values return once the device answers again.',
  },
  setup: {
    word: 'Not on your Wi-Fi',
    tone: 'neutral',
    meaning: 'Capture starts once the device is on your own network.',
  },
  fault: { word: 'Codec fault', tone: 'danger', meaning: 'The audio codec did not start.' },
  'no-bridge': {
    word: 'No bridge yet',
    tone: 'warn',
    meaning: 'The input is captured, but the device has nowhere to send it.',
  },
  paused: {
    word: 'Paused',
    tone: 'neutral',
    meaning: 'Streaming is paused. Resume sends audio again; a restart resumes it too.',
  },
  quiet: {
    word: 'Quiet input',
    tone: 'neutral',
    meaning: 'The input is silent, so the device keeps the stream open with silence.',
  },
  checking: {
    word: 'Checking delivery',
    tone: 'unknown',
    meaning: 'Audio is playing; the next read shows whether it leaves for the bridge.',
  },
  connecting: {
    word: 'Connecting to the bridge',
    tone: 'warn',
    meaning: 'Audio is playing, but nothing has left for the bridge since the last read.',
  },
  sending: {
    word: 'Sending audio',
    tone: 'positive',
    active: true,
    meaning: 'Audio is leaving for the bridge. The bridge console shows whether it arrives.',
  },
};

/** The activity as a status, for a top bar. */
export function ActivityStatus({ activity }: { activity: AudioActivity }) {
  const words = ACTIVITY[activity];
  return (
    <Status tone={words.tone} active={words.active}>
      {words.word}
    </Status>
  );
}
