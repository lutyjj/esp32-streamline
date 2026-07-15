import { describe, expect, it, vi } from 'vitest';
import {
  CAL_ATTEN_MAX,
  CAL_ATTEN_STEP,
  CAL_SIGNAL_RMS,
  CAL_SILENCE_MAX_POLLS,
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

  it('collects the full quorum over intermittent missed polls', async () => {
    let calls = 0;
    const progress: number[] = [];
    const { engine } = engineWith([], {
      sample: async () => {
        calls += 1;
        if (calls % 2 === 0) throw new Error('poll lost');
        return sample(20);
      },
      silenceProgress: (fraction) => progress.push(fraction),
    });
    const outcome = await engine.measureSilence();
    expect(outcome).toEqual({ kind: 'measured', floor: 20 });
    expect(calls).toBe(CAL_SILENCE_SAMPLES * 2 - 1);
    expect(progress).toHaveLength(CAL_SILENCE_SAMPLES);
    expect(progress.at(-1)).toBe(1);
  });

  it('reports unavailable when the polling deadline cannot provide evidence', async () => {
    let calls = 0;
    const { engine } = engineWith([], {
      sample: async () => {
        calls += 1;
        throw new Error('device unavailable');
      },
    });

    expect(await engine.measureSilence()).toEqual({
      kind: 'unavailable',
      collected: 0,
      required: CAL_SILENCE_SAMPLES,
    });
    expect(calls).toBe(CAL_SILENCE_MAX_POLLS);
  });

  it('stops an in-flight measurement on cancel', async () => {
    let releaseDelay: (() => void) | undefined;
    const { engine } = engineWith([sample(10)], {
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });
    const measurement = engine.measureSilence();
    await vi.waitFor(() => expect(releaseDelay).toBeTypeOf('function'));
    engine.cancel();
    releaseDelay?.();
    expect(await measurement).toEqual({ kind: 'cancelled' });
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

// Stage 4: cancelling calibration leaves the device as it was found, with the
// baseline write ordered after every in-flight calibration write.
describe('cancelAndRestore', () => {
  it('aborts an in-flight device request before restoring', async () => {
    const writes: number[] = [];
    let writeSignal: AbortSignal | undefined;
    const { engine } = engineWith([], {
      applyAttenuation: (atten, signal) => {
        writes.push(atten);
        if (atten !== 0) return Promise.resolve();
        writeSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const calibration = engine.findAttenuation(30);
    await vi.waitFor(() => expect(writeSignal).toBeDefined());
    const restore = engine.cancelAndRestore(9);

    await expect(restore).resolves.toBe(true);
    await expect(calibration).resolves.toEqual({ kind: 'cancelled' });
    expect(writeSignal?.aborted).toBe(true);
    expect(writes).toEqual([0, 9]);
  });

  it('makes the baseline the final write after an in-flight calibration write', async () => {
    const writes: number[] = [];
    const releases: (() => void)[] = [];
    const { engine } = engineWith([], {
      applyAttenuation: (atten) => {
        writes.push(atten);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    });

    const calibration = engine.findAttenuation(30);
    await vi.waitFor(() => expect(writes).toEqual([0]));
    const restore = engine.cancelAndRestore(9);
    expect(writes).toEqual([0]);

    releases.shift()?.();
    await vi.waitFor(() => expect(writes).toEqual([0, 9]));
    releases.shift()?.();

    await expect(restore).resolves.toBe(true);
    await expect(calibration).resolves.toEqual({ kind: 'cancelled' });
    expect(engine.applied).toBe(9);
  });

  it('writes nothing when calibration never touched the device', async () => {
    const { engine, applied } = engineWith(Array.from({ length: 8 }, () => sample(20)));
    await engine.measureSilence();
    expect(await engine.cancelAndRestore(9)).toBe(false);
    expect(applied).toEqual([]);
  });

  it('does not rewrite an already-confirmed baseline', async () => {
    const feed = Array.from({ length: CAL_WINDOW_SAMPLES + 1 }, () => sample(20_000));
    const { engine, applied } = engineWith(feed);
    expect((await engine.findAttenuation(30)).kind).toBe('calibrated');

    expect(await engine.cancelAndRestore(0)).toBe(false);
    expect(applied).toEqual([0]);
  });

  it('restores after a write with an unknown remote outcome', async () => {
    const writes: number[] = [];
    const { engine } = engineWith([], {
      applyAttenuation: async (atten) => {
        writes.push(atten);
        if (writes.length === 1) throw new Error('response lost');
      },
    });
    expect(await engine.findAttenuation(30)).toEqual({
      kind: 'apply-failed',
      message: 'response lost',
    });

    expect(await engine.cancelAndRestore(9)).toBe(true);
    expect(writes).toEqual([0, 9]);
    expect(engine.applied).toBe(9);
  });

  it('supports an explicit retry after a failed restore', async () => {
    const feed = Array.from({ length: CAL_WINDOW_SAMPLES + 1 }, () => sample(20_000));
    const writes: number[] = [];
    let restoreAttempts = 0;
    const { engine } = engineWith(feed, {
      applyAttenuation: async (atten) => {
        writes.push(atten);
        if (atten === 9 && restoreAttempts++ === 0) throw new Error('device unreachable');
      },
    });
    await engine.findAttenuation(30);

    await expect(engine.cancelAndRestore(9)).rejects.toThrow('device unreachable');
    expect(engine.applied).toBe(0);
    await expect(engine.cancelAndRestore(9)).resolves.toBe(true);
    expect(writes).toEqual([0, 9, 9]);
    expect(engine.applied).toBe(9);
  });
});
