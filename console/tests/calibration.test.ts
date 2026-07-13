import { describe, expect, it } from 'vitest';
import {
  CAL_ATTEN_MAX,
  CAL_ATTEN_STEP,
  CAL_SIGNAL_RMS,
  CAL_SILENCE_SAMPLES,
  CAL_WINDOW_SAMPLES,
  type CalibrationDeps,
  CalibrationEngine,
  type CalibrationRange,
  type LevelSample,
} from '../src/lib/calibration';

const THRESHOLD = 32760;

function sample(rms: number, peak = rms, clipped = 0): LevelSample {
  return { rms, peak, clipped, threshold: THRESHOLD };
}

/** Engine wired to a scripted sample feed; applied attenuations are recorded. */
function engineWith(
  samples: LevelSample[],
  overrides: Partial<CalibrationDeps> = {},
  range?: CalibrationRange,
) {
  const applied: number[] = [];
  let index = 0;
  const engine = new CalibrationEngine(
    {
      sample: async () => samples[Math.min(index++, samples.length - 1)],
      applyAttenuation: async (atten) => {
        applied.push(atten);
      },
      delay: async () => {},
      log: () => {},
      ...overrides,
    },
    range,
  );
  return { engine, applied };
}

describe('measureSilence', () => {
  it('reports the median of a quiet room', async () => {
    const feed = [30, 25, 40, 28, 33, 26, 31, 29].map((rms) => sample(rms));
    const { engine } = engineWith(feed);
    const outcome = await engine.measureSilence();
    expect(outcome).toEqual({ kind: 'measured', floor: 30 });
  });

  it('detects playback instead of silence', async () => {
    const feed = Array.from({ length: CAL_SILENCE_SAMPLES }, () => sample(CAL_SIGNAL_RMS * 4));
    const { engine } = engineWith(feed);
    const outcome = await engine.measureSilence();
    expect(outcome.kind).toBe('playback-detected');
  });

  it('stretches over missed polls instead of failing', async () => {
    let calls = 0;
    const { engine } = engineWith([], {
      sample: async () => {
        calls += 1;
        if (calls % 2 === 0) throw new Error('poll lost');
        return sample(20);
      },
    });
    const outcome = await engine.measureSilence();
    expect(outcome.kind).toBe('measured');
  });

  it('stops on cancel', async () => {
    const { engine } = engineWith([sample(10)]);
    engine.cancel();
    expect((await engine.measureSilence()).kind).toBe('cancelled');
  });
});

describe('findAttenuation', () => {
  const LOUD = 20_000;

  it('accepts the first attenuation with a clean loud window', async () => {
    const feed = [
      sample(50), // still waiting for playback
      ...Array.from({ length: CAL_WINDOW_SAMPLES + 1 }, () => sample(LOUD, LOUD)),
    ];
    const { engine, applied } = engineWith(feed);
    const outcome = await engine.findAttenuation(30);
    expect(outcome).toMatchObject({ kind: 'calibrated', atten: 0 });
    expect(applied).toEqual([0]);
  });

  it('raises the attenuation when the window clips', async () => {
    // First window clips via the peak threshold; the retry window is clean.
    const feed = [
      sample(LOUD, LOUD), // ends the waiting phase
      sample(LOUD, LOUD), // rebases the clip window
      sample(LOUD, THRESHOLD), // peak at threshold -> clip
      ...Array.from({ length: CAL_WINDOW_SAMPLES + 2 }, () => sample(LOUD, LOUD)),
    ];
    const { engine, applied } = engineWith(feed);
    const outcome = await engine.findAttenuation(30);
    expect(outcome).toMatchObject({ kind: 'calibrated', atten: CAL_ATTEN_STEP });
    expect(applied).toEqual([0, CAL_ATTEN_STEP]);
  });

  it('counts a rising clip counter as clipping', async () => {
    const feed = [
      sample(LOUD, LOUD, 100), // waiting ends
      sample(LOUD, LOUD, 100), // window rebased at 100 clips
      sample(LOUD, LOUD, 140), // clip counter moved -> clipping
      ...Array.from({ length: CAL_WINDOW_SAMPLES + 2 }, () => sample(LOUD, LOUD, 140)),
    ];
    const { engine } = engineWith(feed);
    const outcome = await engine.findAttenuation(30);
    expect(outcome).toMatchObject({ kind: 'calibrated', atten: CAL_ATTEN_STEP });
  });

  it('re-waits when the signal goes quiet mid-window', async () => {
    const feed = [
      sample(LOUD, LOUD), // waiting ends
      sample(LOUD, LOUD), // rebase
      ...Array.from({ length: CAL_WINDOW_SAMPLES }, () => sample(40, 40)), // quiet window
      sample(LOUD, LOUD), // waiting ends again
      ...Array.from({ length: CAL_WINDOW_SAMPLES + 1 }, () => sample(LOUD, LOUD)),
    ];
    const logs: string[] = [];
    const { engine } = engineWith(feed, { log: (text) => logs.push(text) });
    const outcome = await engine.findAttenuation(30);
    expect(outcome.kind).toBe('calibrated');
    expect(logs.some((l) => l.includes('quiet'))).toBe(true);
  });

  it('gives up when the maximum attenuation still clips', async () => {
    // Every window clips: waiting sample, rebase sample, clip sample, repeat.
    const feed: LevelSample[] = [sample(LOUD, LOUD)];
    for (let i = 0; i <= CAL_ATTEN_MAX / CAL_ATTEN_STEP + 1; i += 1) {
      feed.push(sample(LOUD, LOUD), sample(LOUD, THRESHOLD));
    }
    const { engine, applied } = engineWith(feed);
    const outcome = await engine.findAttenuation(30);
    expect(outcome.kind).toBe('still-clipping-at-max');
    expect(applied.at(-1)).toBe(CAL_ATTEN_MAX);
  });

  it('walks only the range the board reports', async () => {
    // Every window clips; a board with a 6 dB ceiling gives up at 6 dB.
    const feed: LevelSample[] = [sample(LOUD, LOUD)];
    for (let i = 0; i <= 2; i += 1) {
      feed.push(sample(LOUD, LOUD), sample(LOUD, THRESHOLD));
    }
    const { engine, applied } = engineWith(feed, {}, { attenMax: 6, attenStep: 3 });
    const outcome = await engine.findAttenuation(30);
    expect(outcome.kind).toBe('still-clipping-at-max');
    expect(applied.at(-1)).toBe(6);
  });

  it('reports a failed settings write instead of looping', async () => {
    const { engine } = engineWith([sample(LOUD, LOUD)], {
      applyAttenuation: async () => {
        throw new Error('unauthorized');
      },
    });
    const outcome = await engine.findAttenuation(30);
    expect(outcome).toEqual({ kind: 'apply-failed', message: 'unauthorized' });
  });

  it('remembers the last applied attenuation so cancel can restore', async () => {
    const feed = [
      sample(LOUD, LOUD),
      sample(LOUD, LOUD),
      sample(LOUD, THRESHOLD),
      ...Array.from({ length: CAL_WINDOW_SAMPLES + 2 }, () => sample(LOUD, LOUD)),
    ];
    const { engine } = engineWith(feed);
    await engine.findAttenuation(30);
    expect(engine.applied).toBe(CAL_ATTEN_STEP);
  });
});

// Stage 4: cancelling calibration leaves the device as it was found.
describe('restore', () => {
  it('walks the attenuation back to the baseline it moved away from', async () => {
    const { engine, applied } = engineWith([]);
    engine.applied = 12; // calibration raised it during the run
    expect(await engine.restore(0)).toBe(true);
    expect(applied).toEqual([0]);
    expect(engine.applied).toBe(0);
  });

  it('writes nothing when the run never touched the device', async () => {
    const { engine, applied } = engineWith([]);
    expect(await engine.restore(0)).toBe(false);
    expect(applied).toEqual([]);
  });

  it('writes nothing when the applied value already matches the baseline', async () => {
    const { engine, applied } = engineWith([]);
    engine.applied = 6;
    expect(await engine.restore(6)).toBe(false);
    expect(applied).toEqual([]);
  });

  it('surfaces a failed restore write and keeps its recorded state', async () => {
    const { engine } = engineWith([], {
      applyAttenuation: async () => {
        throw new Error('unauthorized');
      },
    });
    engine.applied = 12;
    await expect(engine.restore(0)).rejects.toThrow('unauthorized');
    expect(engine.applied).toBe(12);
  });
});
