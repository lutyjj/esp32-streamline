/**
 * Level-calibration engine: measure the idle floor, then raise the ADC
 * attenuation until the loudest material stops clipping.
 *
 * Pure orchestration over injected effects (sampling, applying settings,
 * delay, progress callbacks) so the whole procedure is unit-testable without
 * a device. The wizard overlay owns the DOM; this owns the decisions.
 */

import { errorMessage } from './errors';
import { dbfs } from './format';

export const CAL_POLL_MS = 500;
/** Polls in the silence measurement (~4 s). */
export const CAL_SILENCE_SAMPLES = 8;
/** Clean polls required at one attenuation before it is accepted (~3 s). */
export const CAL_WINDOW_SAMPLES = 6;
/** Attenuation step between windows; divides the 48 dB range evenly. */
export const CAL_ATTEN_STEP = 3;
export const CAL_ATTEN_MAX = 48;
/** RMS below this is not playback — mirrors the firmware's start gate. */
export const CAL_SIGNAL_RMS = 150;

/** One telemetry poll reduced to the levels calibration reasons about. */
export interface LevelSample {
  rms: number;
  peak: number;
  clipped: number;
  threshold: number;
}

export interface CalibrationDeps {
  sample(): Promise<LevelSample>;
  applyAttenuation(atten: number): Promise<void>;
  delay(ms: number): Promise<void>;
  /** Narration for the wizard's activity log. */
  log(text: string, cls?: 'ok' | ''): void;
  /** Live meter feedback while listening for loud material. */
  levels?(sample: LevelSample): void;
  /** Silence-measurement progress, 0..1, with the current median floor. */
  silenceProgress?(fraction: number, rms: number): void;
}

export type SilenceResult =
  | { kind: 'measured'; floor: number }
  | { kind: 'playback-detected'; floor: number }
  | { kind: 'cancelled' };

export type LoudResult =
  | { kind: 'calibrated'; atten: number; peak: number; peakDb: string }
  | { kind: 'still-clipping-at-max' }
  | { kind: 'apply-failed'; message: string }
  | { kind: 'cancelled' };

export class CalibrationEngine {
  private cancelled = false;
  /** The attenuation last written to the device, or null if none was. */
  applied: number | null = null;

  constructor(private deps: CalibrationDeps) {}

  cancel(): void {
    this.cancelled = true;
  }

  /** Median RMS over a few seconds of what should be silence. */
  async measureSilence(): Promise<SilenceResult> {
    const samples: number[] = [];
    for (let i = 0; i < CAL_SILENCE_SAMPLES; i += 1) {
      await this.deps.delay(CAL_POLL_MS);
      if (this.cancelled) return { kind: 'cancelled' };
      let sample: LevelSample;
      try {
        sample = await this.deps.sample();
      } catch {
        continue; // a missed poll only stretches the measurement
      }
      if (this.cancelled) return { kind: 'cancelled' };
      samples.push(sample.rms);
      this.deps.silenceProgress?.((i + 1) / CAL_SILENCE_SAMPLES, sample.rms);
    }
    samples.sort((a, b) => a - b);
    const floor = samples[Math.floor(samples.length / 2)] || 0;
    if (floor >= CAL_SIGNAL_RMS) return { kind: 'playback-detected', floor };
    return { kind: 'measured', floor };
  }

  /**
   * From 0 dB, raise attenuation on every clipped window until a full window
   * of loud material passes clean.
   */
  async findAttenuation(idleFloor: number): Promise<LoudResult> {
    let atten = 0;
    const gate = Math.max(CAL_SIGNAL_RMS, idleFloor * 3);
    try {
      await this.applyAttenuation(atten);
    } catch (error) {
      return { kind: 'apply-failed', message: errorMessage(error) };
    }
    if (this.cancelled) return { kind: 'cancelled' };
    this.deps.log('Waiting for playback — press play and turn it up…');
    let waiting = true;
    let windowStart: number | null = null;
    let windowPeak = 0;
    let count = 0;
    while (!this.cancelled) {
      await this.deps.delay(CAL_POLL_MS);
      if (this.cancelled) break;
      let s: LevelSample;
      try {
        s = await this.deps.sample();
      } catch {
        continue;
      }
      if (this.cancelled) break;
      this.deps.levels?.(s);
      if (waiting) {
        if (s.rms < gate) continue;
        waiting = false;
        windowStart = null;
        this.deps.log('Hearing it. Checking 0 dB…');
      }
      if (windowStart === null) {
        // (Re)base the clip counter on this poll so samples clipped under the
        // previous attenuation do not count against the new one.
        windowStart = s.clipped;
        windowPeak = 0;
        count = 0;
        continue;
      }
      if (s.rms < gate) {
        this.deps.log('Signal went quiet — keep the loud part playing…');
        waiting = true;
        windowStart = null;
        count = 0;
        continue;
      }
      count += 1;
      windowPeak = Math.max(windowPeak, s.peak);
      if (s.clipped > windowStart || s.peak >= s.threshold) {
        if (atten >= CAL_ATTEN_MAX) return { kind: 'still-clipping-at-max' };
        atten += CAL_ATTEN_STEP;
        try {
          await this.applyAttenuation(atten);
        } catch (error) {
          return { kind: 'apply-failed', message: errorMessage(error) };
        }
        if (this.cancelled) break;
        this.deps.log(`Clipping — raising to ${atten} dB…`);
        windowStart = null;
        continue;
      }
      if (count < CAL_WINDOW_SAMPLES) continue;
      this.deps.log(`Clean at ${atten} dB — no clipping, peak ${dbfs(windowPeak)} dBFS.`, 'ok');
      return { kind: 'calibrated', atten, peak: windowPeak, peakDb: dbfs(windowPeak) };
    }
    return { kind: 'cancelled' };
  }

  private async applyAttenuation(atten: number): Promise<void> {
    await this.deps.applyAttenuation(atten);
    this.applied = atten;
  }
}
