import { Chip, type Tone } from '../components/Chip';

/** Lifecycle and recording states share the console's status tones. */
function stateTone(state: string): Tone {
  switch (state) {
    case 'connected':
    case 'complete':
      return 'good';
    case 'recording':
      return 'bad';
    case 'waiting-for-audio':
    case 'interrupted':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function StateChip({ state }: { state: string }) {
  return (
    <Chip tone={stateTone(state)} dot>
      {state.replaceAll('-', ' ')}
    </Chip>
  );
}
