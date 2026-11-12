import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

/** The e2e image ships browsers for its own Playwright version only. */
it('pins @playwright/test to the e2e image version', () => {
  const dockerfile = readFileSync(resolve('Dockerfile.e2e'), 'utf8');
  const image = /^FROM mcr\.microsoft\.com\/playwright:v([^-@\s]+)/m.exec(dockerfile)?.[1];
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };

  expect(image).toBeDefined();
  expect(manifest.devDependencies['@playwright/test']).toBe(image);
});
