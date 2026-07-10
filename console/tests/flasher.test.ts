import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('WebFlasher build', () => {
  it('serves the deployment manifest during development', () => {
    expect(config.publicDir).toBe(
      process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../../webflasher'),
    );
  });
});
