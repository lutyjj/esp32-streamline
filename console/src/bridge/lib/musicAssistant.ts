/** Where a published source stands on its way to a Music Assistant live input. */

import type { StatusTone } from 'linen';
import type { SendspinSourceSnapshot } from '../../generated/bridge';

export interface MusicAssistantStep {
  tone: StatusTone;
  label: string;
  detail: string;
  /** Pairing is the next step, so its action leads. */
  pairs: boolean;
}

export function musicAssistantStep(source: SendspinSourceSnapshot): MusicAssistantStep {
  if (source.connection === 'connecting')
    return {
      tone: 'warn',
      label: 'Connecting',
      detail:
        'The bridge cannot reach Music Assistant yet and keeps trying. Check the Sendspin server address and that Music Assistant runs.',
      pairs: false,
    };
  if (!source.paired)
    return {
      tone: 'warn',
      label: 'Needs pairing',
      detail: `Make a pairing token, then paste it into the setup of “${source.name}” in Music Assistant.`,
      pairs: true,
    };
  if (!source.input_enabled)
    return {
      tone: 'warn',
      label: 'Input off',
      detail: `Music Assistant has not turned this input on. Run the setup of “${source.name}” there again and allow its audio input.`,
      pairs: false,
    };
  if (source.streaming)
    return {
      tone: 'positive',
      label: 'Playing',
      detail: 'Music Assistant is receiving this source.',
      pairs: false,
    };
  return {
    tone: 'positive',
    label: 'Ready',
    detail:
      source.signal === 'present'
        ? 'The input has a signal. Play it from Live Inputs in Music Assistant, or let Music Assistant start it on its own.'
        : 'Play it from Live Inputs in Music Assistant. With automatic playback set there, it starts when the input gets a signal.',
    pairs: false,
  };
}
