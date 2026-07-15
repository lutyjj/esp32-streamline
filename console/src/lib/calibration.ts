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
/** Maximum polls allowed to collect the silence quorum (~8 s plus request time). */
export const CAL_SILENCE_MAX_POLLS = CAL_SILENCE_SAMPLES * 2;
/** Longest one device request may delay calibration or cancellation. */
export const CAL_REQUEST_TIMEOUT_MS = 5000;
/** Clean polls required at one attenuation before it is accepted (~3 s). */
export const CAL_WINDOW_SAMPLES = 6;
/** Attenuation step between windows; divides the default range evenly. */
export const CAL_ATTEN_STEP = 3;
/** Fallback attenuation ceiling when the device has not reported its own. */
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
  sample(signal: AbortSignal): Promise<LevelSample>;
  applyAttenuation(atten: number, signal: AbortSignal): Promise<void>;
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
  | { kind: 'unavailable'; collected: number; required: number }
  | { kind: 'cancelled' };

export type LoudResult =
  | { kind: 'calibrated'; atten: number; peak: number; peakDb: string }
  | { kind: 'still-clipping-at-max' }
  | { kind: 'apply-failed'; message: string }
  | { kind: 'cancelled' };

/** Attenuation range to walk; the board's reported capabilities set it. */
export interface CalibrationRange {
  attenMax: number;
  attenStep: number;
}

export class CalibrationEngine {
  private operation = 0;
  private operationController: AbortController | null = null;
  private closing = false;
  private writeTail: Promise<void> = Promise.resolve();
  private writeAttempted = false;
  private writeUncertain = false;
  private appliedAttenuation: number | null = null;

  constructor(
    private deps: CalibrationDeps,
    private range: CalibrationRange = { attenMax: CAL_ATTEN_MAX, attenStep: CAL_ATTEN_STEP },
  ) {}

  cancel(): void {
    this.operation += 1;
    this.operationController?.abort();
    this.operationController = null;
  }

  /** The last attenuation the device confirmed, or null before a successful write. */
  get applied(): number | null {
    return this.appliedAttenuation;
  }

  /** Median RMS over a few seconds of what should be silence. */
  async measureSilence(): Promise<SilenceResult> {
    const operation = this.beginOperation();
    if (this.interrupted(operation)) return { kind: 'cancelled' };
    const samples: number[] = [];
    for (
      let polls = 0;
      polls < CAL_SILENCE_MAX_POLLS && samples.length < CAL_SILENCE_SAMPLES;
      polls += 1
    ) {
      await this.deps.delay(CAL_POLL_MS);
      if (this.interrupted(operation)) return { kind: 'cancelled' };
      let sample: LevelSample;
      try {
        sample = await this.deps.sample(this.requestSignal(operation));
      } catch {
        continue;
      }
      if (this.interrupted(operation)) return { kind: 'cancelled' };
      samples.push(sample.rms);
      this.deps.silenceProgress?.(samples.length / CAL_SILENCE_SAMPLES, sample.rms);
    }
    if (samples.length < CAL_SILENCE_SAMPLES) {
      return {
        kind: 'unavailable',
        collected: samples.length,
        required: CAL_SILENCE_SAMPLES,
      };
    }
    samples.sort((a, b) => a - b);
    const floor = samples[Math.floor(samples.length / 2)];
    if (floor >= CAL_SIGNAL_RMS) return { kind: 'playback-detected', floor };
    return { kind: 'measured', floor };
  }

  /**
   * From 0 dB, raise attenuation on every clipped window until a full window
   * of loud material passes clean.
   */
  async findAttenuation(idleFloor: number): Promise<LoudResult> {
    const operation = this.beginOperation();
    if (this.interrupted(operation)) return { kind: 'cancelled' };
    let atten = 0;
    const gate = Math.max(CAL_SIGNAL_RMS, idleFloor * 3);
    try {
      await this.applyAttenuation(atten, operation);
    } catch (error) {
      if (this.interrupted(operation)) return { kind: 'cancelled' };
      return { kind: 'apply-failed', message: errorMessage(error) };
    }
    if (this.interrupted(operation)) return { kind: 'cancelled' };
    this.deps.log('Waiting for playback — press play and turn it up…');
    let waiting = true;
    let windowStart: number | null = null;
    let windowPeak = 0;
    let count = 0;
    while (!this.interrupted(operation)) {
      await this.deps.delay(CAL_POLL_MS);
      if (this.interrupted(operation)) break;
      let s: LevelSample;
      try {
        s = await this.deps.sample(this.requestSignal(operation));
      } catch {
        continue;
      }
      if (this.interrupted(operation)) break;
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
        if (atten >= this.range.attenMax) return { kind: 'still-clipping-at-max' };
        atten += this.range.attenStep;
        try {
          await this.applyAttenuation(atten, operation);
        } catch (error) {
          if (this.interrupted(operation)) return { kind: 'cancelled' };
          return { kind: 'apply-failed', message: errorMessage(error) };
        }
        if (this.interrupted(operation)) break;
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

  /**
   * Stop calibration, wait for every requested write, then make `baseline` the
   * final device write. A failed request has an unknown remote outcome, so it
   * also requires an explicit baseline write. The method can be retried after a
   * restore failure.
   */
  async cancelAndRestore(baseline: number): Promise<boolean> {
    this.closing = true;
    this.cancel();
    await this.writeTail;
    if (!this.writeAttempted) return false;
    if (this.appliedAttenuation === baseline && !this.writeUncertain) return false;
    await this.applyAttenuation(baseline);
    return true;
  }

  private async applyAttenuation(atten: number, operation?: number): Promise<void> {
    this.writeAttempted = true;
    const write = this.writeTail.then(async () => {
      try {
        const signal =
          operation === undefined
            ? AbortSignal.timeout(CAL_REQUEST_TIMEOUT_MS)
            : this.requestSignal(operation);
        await this.deps.applyAttenuation(atten, signal);
        this.appliedAttenuation = atten;
        this.writeUncertain = false;
      } catch (error) {
        this.writeUncertain = true;
        throw error;
      }
    });
    this.writeTail = write.catch(() => {});
    await write;
  }

  private beginOperation(): number {
    this.operation += 1;
    this.operationController?.abort();
    this.operationController = new AbortController();
    return this.operation;
  }

  private requestSignal(operation: number): AbortSignal {
    if (operation !== this.operation || !this.operationController) return AbortSignal.abort();
    return AbortSignal.any([
      this.operationController.signal,
      AbortSignal.timeout(CAL_REQUEST_TIMEOUT_MS),
    ]);
  }

  private interrupted(operation: number): boolean {
    return this.closing || operation !== this.operation;
  }
}
