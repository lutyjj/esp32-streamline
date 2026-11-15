/**
 * The calibration guide: measure the quiet floor while the owner pauses the
 * source, then raise the attenuation while loud material plays until it
 * stops clipping. Finishing keeps the measured level, which the device has
 * already applied; closing earlier puts back the attenuation the guide began
 * from, and says so when it cannot.
 */

import { signal } from '@preact/signals';
import { errorMessage } from '../../shared/errors';
import { type AudioSettings, getStatus, setAudio } from '../lib/api';
import { CAL_ATTEN_STEP, CalibrationEngine, type LevelSample } from '../lib/calibration';

export type Calibration =
  /** Asks the owner to pause the source. */
  | { phase: 'pause-source' }
  | { phase: 'measuring-quiet'; progress: number }
  /** Measuring the quiet did not work; the owner can measure again. */
  | { phase: 'quiet-refused'; reason: string }
  /** Asks the owner to play the loudest material. */
  | { phase: 'play-loud'; floor: number }
  | { phase: 'listening'; attenuation: number }
  /** Finding the level did not work; the owner can listen again. */
  | { phase: 'loud-refused'; floor: number; reason: string }
  | { phase: 'done'; attenuation: number; peakDb: string }
  | { phase: 'restoring' }
  | { phase: 'restore-failed'; reason: string }
  /** `restored` says whether closing wrote the entry attenuation back. */
  | { phase: 'closed'; restored: boolean };

/** The device as the guide reads and writes it. */
export interface CalibrationDevice {
  sample(signal: AbortSignal): Promise<LevelSample>;
  setAttenuation(attenuation: number, signal: AbortSignal): Promise<void>;
}

/** The device behind the API, keeping the input line and gain the guide began with. */
export function deviceCalibration(entry: AudioSettings): CalibrationDevice {
  return {
    async sample(signal) {
      const { metrics } = await getStatus({ signal });
      return {
        rms: Math.max(metrics.rms_left, metrics.rms_right),
        peak: Math.max(metrics.peak_abs_left, metrics.peak_abs_right),
        clipped: metrics.clipped_samples_total,
        threshold: metrics.clip_threshold_abs,
      };
    },
    async setAttenuation(attenuation, signal) {
      await setAudio({ ...entry, adc_attenuation_db: attenuation }, { signal });
    },
  };
}

export class CalibrationGuide {
  readonly state = signal<Calibration>({ phase: 'pause-source' });
  private readonly engine: CalibrationEngine;

  constructor(
    private readonly entry: AudioSettings,
    private readonly attenuationMax: number,
    device: CalibrationDevice,
    delay: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {
    this.engine = new CalibrationEngine(
      {
        sample: (abort) => device.sample(abort),
        applyAttenuation: async (attenuation, abort) => {
          await device.setAttenuation(attenuation, abort);
          if (this.state.value.phase === 'listening') {
            this.state.value = { phase: 'listening', attenuation };
          }
        },
        delay,
        log: () => {},
        silenceProgress: (progress) => {
          if (this.state.value.phase === 'measuring-quiet') {
            this.state.value = { phase: 'measuring-quiet', progress };
          }
        },
      },
      { attenMax: attenuationMax, attenStep: CAL_ATTEN_STEP },
    );
  }

  async measureQuiet(): Promise<void> {
    this.state.value = { phase: 'measuring-quiet', progress: 0 };
    const result = await this.engine.measureSilence();
    if (this.state.value.phase !== 'measuring-quiet') return;
    switch (result.kind) {
      case 'cancelled':
        return;
      case 'unavailable':
        this.state.value = {
          phase: 'quiet-refused',
          reason: `Only ${result.collected} of ${result.required} level readings arrived. Check the device’s connection, then measure again.`,
        };
        return;
      case 'playback-detected':
        this.state.value = {
          phase: 'quiet-refused',
          reason: 'That sounds like playback, not quiet. Pause the source, then measure again.',
        };
        return;
      case 'measured':
        this.state.value = { phase: 'play-loud', floor: result.floor };
    }
  }

  async findLevel(): Promise<void> {
    const now = this.state.value;
    if (now.phase !== 'play-loud' && now.phase !== 'loud-refused') return;
    const floor = now.floor;
    this.state.value = { phase: 'listening', attenuation: this.entry.adc_attenuation_db };
    const result = await this.engine.findAttenuation(floor);
    if (this.state.value.phase !== 'listening') return;
    switch (result.kind) {
      case 'cancelled':
        return;
      case 'still-clipping-at-max':
        this.state.value = {
          phase: 'loud-refused',
          floor,
          reason: `It still clips at ${this.attenuationMax} dB. Turn the source’s volume down, then listen again.`,
        };
        return;
      case 'apply-failed':
        this.state.value = {
          phase: 'loud-refused',
          floor,
          reason: `The attenuation did not change: ${result.message}`,
        };
        return;
      case 'calibrated':
        this.state.value = { phase: 'done', attenuation: result.atten, peakDb: result.peakDb };
    }
  }

  /** Close the guide; anything short of done puts the entry attenuation back. */
  async close(): Promise<void> {
    if (this.state.value.phase === 'done') {
      this.engine.cancel();
      this.state.value = { phase: 'closed', restored: false };
      return;
    }
    this.state.value = { phase: 'restoring' };
    try {
      const restored = await this.engine.cancelAndRestore(this.entry.adc_attenuation_db);
      this.state.value = { phase: 'closed', restored };
    } catch (error) {
      this.state.value = {
        phase: 'restore-failed',
        reason: `The attenuation is not back at ${this.entry.adc_attenuation_db} dB: ${errorMessage(error)}`,
      };
    }
  }
}
