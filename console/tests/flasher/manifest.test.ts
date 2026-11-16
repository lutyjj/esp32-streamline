import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('WebFlasher site', () => {
  it('ships a manifest the browser parses', () => {
    const site =
      process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../../../webflasher');
    const manifest = JSON.parse(readFileSync(resolve(site, 'manifest.json'), 'utf8'));
    expect(manifest.builds).not.toHaveLength(0);
  });
});
