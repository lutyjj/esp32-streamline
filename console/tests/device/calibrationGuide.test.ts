import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import type { LevelSample } from '../../src/device/lib/calibration';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  type CalibrationDevice,
  CalibrationGuide,
  calibrationHeld,
  calibrationStep,
  calibrationUnderway,
  deviceCalibration,
} from '../../src/device/state/calibration';
import { connection } from '../../src/device/state/device';
import { answering } from './answering';

const ENTRY = { input_line: 1, input_gain: 24, adc_attenuation_db: 6 };

/**
 * A source the guide listens to: quiet or loud, clipping until the
 * attenuation reaches `cleanAt`. `failWrites` makes every write fail.
 */
class FakeSource implements CalibrationDevice {
  attenuation = ENTRY.adc_attenuation_db;
  loud = false;
  failWrites = false;
  writes: number[] = [];
  private clipped = 0;

  constructor(private readonly cleanAt: number) {}

  async sample(): Promise<LevelSample> {
    if (!this.loud) return { rms: 10, peak: 40, clipped: this.clipped, threshold: 32_000 };
    const clips = this.attenuation < this.cleanAt;
    if (clips) this.clipped += 5;
    return { rms: 6_000, peak: clips ? 32_767 : 20_000, clipped: this.clipped, threshold: 32_000 };
  }

  async setAttenuation(attenuation: number): Promise<void> {
    if (this.failWrites) throw new Error('the device is busy');
    this.writes.push(attenuation);
    this.attenuation = attenuation;
  }
}

const now = async () => {};

function guide(source: FakeSource, max = 24): CalibrationGuide {
  return new CalibrationGuide(ENTRY, max, source, now);
}

describe('the calibration guide', () => {
  it('measures the quiet, then raises the attenuation until loud material stops clipping', async () => {
    const source = new FakeSource(9);
    const calibration = guide(source);
    await calibration.measureQuiet();
    expect(calibration.state.value).toMatchObject({ phase: 'play-loud' });

    source.loud = true;
    await calibration.findLevel();
    expect(calibration.state.value).toMatchObject({ phase: 'done', attenuation: 9 });
    expect(source.attenuation).toBe(9);

    // Finishing keeps the measured level.
    await calibration.close();
    expect(calibration.state.value).toEqual({ phase: 'closed', restored: false });
    expect(source.attenuation).toBe(9);
  });

  it('asks for quiet again when it hears playback', async () => {
    const source = new FakeSource(0);
    source.loud = true;
    const calibration = guide(source);
    await calibration.measureQuiet();
    expect(calibration.state.value).toMatchObject({
      phase: 'quiet-refused',
      reason: expect.stringContaining('Pause the source'),
    });
  });

  it('says when the source clips even at the board’s ceiling, and can listen again', async () => {
    const source = new FakeSource(99);
    const calibration = guide(source, 12);
    await calibration.measureQuiet();
    source.loud = true;
    await calibration.findLevel();
    expect(calibration.state.value).toMatchObject({
      phase: 'loud-refused',
      reason: expect.stringContaining('12 dB'),
    });
    await calibration.close();
    expect(calibration.state.value).toEqual({ phase: 'closed', restored: true });
    expect(source.attenuation).toBe(ENTRY.adc_attenuation_db);
  });

  it('closing early puts the entry attenuation back', async () => {
    const source = new FakeSource(9);
    const calibration = guide(source);
    await calibration.measureQuiet();
    source.loud = true;
    // The guide wrote 0 dB to start listening before the owner closed it.
    source.writes = [];
    const listening = calibration.findLevel();
    await calibration.close();
    await listening;
    expect(source.attenuation).toBe(ENTRY.adc_attenuation_db);
    expect(calibration.state.value).toEqual({ phase: 'closed', restored: true });
  });

  it('says when the entry attenuation could not be put back, and can try again', async () => {
    const source = new FakeSource(99);
    const calibration = guide(source, 12);
    await calibration.measureQuiet();
    source.loud = true;
    await calibration.findLevel();
    source.failWrites = true;
    await calibration.close();
    expect(calibration.state.value).toMatchObject({
      phase: 'restore-failed',
      reason: expect.stringContaining('not back at 6 dB'),
    });
    source.failWrites = false;
    await calibration.close();
    expect(calibration.state.value).toEqual({ phase: 'closed', restored: true });
  });
});

describe('where the guide stands', () => {
  it('places each phase in its step, and none while it closes', () => {
    expect(calibrationStep({ phase: 'quiet-refused', reason: '' })).toBe('quiet');
    expect(calibrationStep({ phase: 'listening', attenuation: 9 })).toBe('loud');
    expect(calibrationStep({ phase: 'done', attenuation: 12, peakDb: '-3.0' })).toBe('done');
    expect(calibrationStep({ phase: 'restoring' })).toBeNull();
  });

  it('asks before leaving only once a measurement has begun and until it is done', () => {
    expect(calibrationUnderway({ phase: 'pause-source' })).toBe(false);
    expect(calibrationUnderway({ phase: 'measuring-quiet', progress: 0.5 })).toBe(true);
    expect(calibrationUnderway({ phase: 'loud-refused', floor: 10, reason: '' })).toBe(true);
    expect(calibrationUnderway({ phase: 'done', attenuation: 12, peakDb: '-3.0' })).toBe(false);
    expect(calibrationUnderway({ phase: 'closed', restored: true })).toBe(false);
  });
});

describe('a device the guide cannot calibrate', () => {
  afterEach(() => {
    forgetAdminKey();
    setTransport((request) => fetch(request));
    answering(null);
  });

  it('holds the guide until the input runs on the home network', () => {
    answering(deviceStatus({ mode: 'recovery' }));
    expect(calibrationHeld.value).toContain('back on your Wi-Fi');
    const silent = deviceStatus();
    silent.health.checks[0] = { ...silent.health.checks[0], severity: 'blocking', status: 'fail' };
    answering(silent);
    expect(calibrationHeld.value).toContain('did not start');
    answering(deviceStatus());
    expect(calibrationHeld.value).toBeNull();
  });

  it('stops, and says the device restarts, when a write would restart it', async () => {
    answering(deviceStatus());
    unlockSettings('a'.repeat(48), false);
    setTransport(async () => Response.json({ ok: true, rebooting: true }));
    const entry = { input_line: 2, input_gain: 0, adc_attenuation_db: 9 };
    await expect(
      deviceCalibration(entry).setAttenuation(12, AbortSignal.timeout(1000)),
    ).rejects.toThrow('calibration stops');
    expect(connection.value).toMatchObject({ phase: 'waiting', operation: 'the calibration' });
  });
});
