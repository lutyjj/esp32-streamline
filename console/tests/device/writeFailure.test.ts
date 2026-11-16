import { describe, expect, it } from 'vitest';
import { UnansweredError } from '../../src/device/lib/http';
import { writeFailure } from '../../src/device/state/writeFailure';
import { ApiError } from '../../src/shared/http';

const FAILED = 'The profiles did not change.';

describe('writeFailure', () => {
  it('says a refusal did not happen, in the device’s words, field or not', () => {
    for (const error of [
      new ApiError(400, 'A device keeps at most 8 profiles.', 'catalog'),
      new ApiError(500, 'The device could not store the profiles.'),
    ]) {
      expect(writeFailure(error, FAILED)).toEqual({
        tone: 'danger',
        title: FAILED,
        description: error.message,
      });
    }
  });

  it('says a write left unanswered or dropped may have happened', () => {
    for (const error of [new UnansweredError(), new TypeError('Failed to fetch')]) {
      expect(writeFailure(error, FAILED)).toMatchObject({
        tone: 'warn',
        title: 'The device did not answer.',
      });
    }
  });

  it('says why a write the console never sent did not go', () => {
    expect(writeFailure(new Error('That profile is gone.'), FAILED)).toEqual({
      tone: 'danger',
      title: FAILED,
      description: 'That profile is gone.',
    });
  });
});
