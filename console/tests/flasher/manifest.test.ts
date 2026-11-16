import { describe, expect, it } from 'vitest';
import manifest from '../../../webflasher/manifest.json';

describe('WebFlasher site', () => {
  it('ships a manifest the browser parses', () => {
    expect(manifest.builds).not.toHaveLength(0);
  });
});
