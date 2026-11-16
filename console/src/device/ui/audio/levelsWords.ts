import type { AudioSettings, CapabilitiesStatus } from '../../lib/api';

/** Levels in words, such as "Line 2, 3.5 mm jack · gain 0 · attenuation 9 dB". */
export function levelsWords(
  audio: AudioSettings,
  lines: CapabilitiesStatus['input_lines'],
): string {
  const line =
    lines.find((entry) => entry.line === audio.input_line)?.label ?? `Line ${audio.input_line}`;
  return `${line} · gain ${audio.input_gain} · attenuation ${audio.adc_attenuation_db} dB`;
}
