import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/lib/errors';

describe('errorMessage', () => {
  it('unwraps Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies everything else', () => {
    expect(errorMessage('plain rejection')).toBe('plain rejection');
  });
});
