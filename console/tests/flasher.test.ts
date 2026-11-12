import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('WebFlasher build', () => {
  it('serves the deployment manifest during development', () => {
    expect(config.publicDir).toBe(
      process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../../webflasher'),
    );
  });

  it('ships a manifest the browser parses', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(config.publicDir as string, 'manifest.json'), 'utf8'),
    );
    expect(manifest.builds).not.toHaveLength(0);
  });
});
