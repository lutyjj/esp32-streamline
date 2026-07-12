import { describe, expect, it } from 'vitest';
import { viewFromHash, viewHref } from '../src/state/navigation';

describe('console navigation', () => {
  it('maps path-shaped hashes to named views', () => {
    expect(viewFromHash('#/audio')).toBe('audio');
    expect(viewFromHash('#api')).toBe('api');
    expect(viewFromHash('#/network?source=callout')).toBe('network');
  });

  it('falls back to overview for root and unknown paths', () => {
    expect(viewFromHash('')).toBe('overview');
    expect(viewFromHash('#/unknown')).toBe('overview');
  });

  it('generates reload-safe links for the embedded single page', () => {
    expect(viewHref('system')).toBe('#/system');
  });
});
