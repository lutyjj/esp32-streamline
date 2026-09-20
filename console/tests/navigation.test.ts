import { describe, expect, it } from 'vitest';
import { viewFromHash, viewHref } from '../src/state/navigation';

describe('console navigation', () => {
  it('maps path-shaped hashes to named views', () => {
    expect(viewFromHash('#/audio')).toBe('audio');
    expect(viewFromHash('#settings')).toBe('settings');
    expect(viewFromHash('#/connections?source=callout')).toBe('connections');
  });

  it('falls back to audio for root and unknown paths', () => {
    expect(viewFromHash('')).toBe('audio');
    expect(viewFromHash('#/unknown')).toBe('audio');
  });

  it('generates reload-safe links for the embedded single page', () => {
    expect(viewHref('settings')).toBe('#/settings');
  });
});
