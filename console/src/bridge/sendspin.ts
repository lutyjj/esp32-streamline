import type { Tone } from '../components/Chip';
import type { SendspinSourceSnapshot } from '../generated/bridge';

export interface SendspinSourceView {
  label: string;
  tone: Tone;
  detail: string;
  /** Whether the next step is pairing, so the pairing action leads. */
  needsPairing: boolean;
}

/** Where one published source stands on its way to a Music Assistant live input. */
export function sendspinSourceView(source: SendspinSourceSnapshot): SendspinSourceView {
  if (source.connection === 'connecting') {
    return {
      label: 'Connecting',
      tone: 'warn',
      detail:
        'The bridge cannot reach Music Assistant yet and retries on its own. Check the Sendspin server URL and that Music Assistant is running.',
      needsPairing: false,
    };
  }
  if (!source.paired) {
    return {
      label: 'Needs pairing',
      tone: 'warn',
      detail: `Create a pairing token, then paste it into the setup of “${source.name}” in Music Assistant.`,
      needsPairing: true,
    };
  }
  if (!source.input_enabled) {
    return {
      label: 'Input off',
      tone: 'warn',
      detail: `Music Assistant has not enabled this input. Run the setup of “${source.name}” in Music Assistant again and allow its audio input.`,
      needsPairing: false,
    };
  }
  if (source.streaming) {
    return {
      label: 'Playing',
      tone: 'good',
      detail: 'Music Assistant is receiving this source.',
      needsPairing: false,
    };
  }
  return {
    label: 'Ready',
    tone: 'good',
    detail:
      source.signal === 'present'
        ? 'The input has a signal. Play it from Live Inputs in Music Assistant, or let Music Assistant start it automatically.'
        : 'Play it from Live Inputs in Music Assistant. With automatic playback set there, it starts when the input gets a signal.',
    needsPairing: false,
  };
}
