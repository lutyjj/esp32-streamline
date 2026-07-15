import { describe, expect, it } from 'vitest';
import { nextPeakHold, PEAK_HOLD_MS } from '../src/state/device';

describe('peak hold', () => {
  it.each([
    ['left', 240, 80, 240, 100],
    ['right', 80, 240, 100, 240],
  ] as const)(
    'holds a new %s-channel peak for its full window',
    (_channel, left, right, heldLeft, heldRight) => {
      const initial = { left: 100, right: 100, at: 1_000 };
      const risen = nextPeakHold(initial, left, right, 2_000);

      expect(risen).toEqual({ left: heldLeft, right: heldRight, at: 2_000 });
      expect(nextPeakHold(risen, 20, 20, 2_000 + PEAK_HOLD_MS)).toEqual(risen);
      expect(nextPeakHold(risen, 20, 20, 2_000 + PEAK_HOLD_MS + 1)).toEqual({
        left: 20,
        right: 20,
        at: 2_000 + PEAK_HOLD_MS + 1,
      });
    },
  );

  it('refreshes the shared hold window across alternating channel peaks', () => {
    const initial = { left: 100, right: 100, at: 1_000 };
    const leftRise = nextPeakHold(initial, 240, 80, 2_000);
    const rightRise = nextPeakHold(leftRise, 20, 260, 3_000);

    expect(rightRise).toEqual({ left: 240, right: 260, at: 3_000 });
    expect(nextPeakHold(rightRise, 20, 20, 3_000 + PEAK_HOLD_MS)).toEqual(rightRise);
  });
});
