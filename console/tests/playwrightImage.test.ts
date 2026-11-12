import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

/**
 * The e2e image carries only its own Playwright version's browsers, so a
 * runner pinned to another version cannot launch one. Dependabot moves the
 * image and the npm pin in separate updates; this fails the console tests
 * until both name the same version.
 */
it('pins @playwright/test to the e2e image version', () => {
  // vitest runs with the console package as its working directory.
  const dockerfile = readFileSync(resolve('Dockerfile.e2e'), 'utf8');
  const image = /^FROM mcr\.microsoft\.com\/playwright:v([^-@\s]+)/m.exec(dockerfile)?.[1];
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };

  expect(image).toBeDefined();
  expect(manifest.devDependencies['@playwright/test']).toBe(image);
});
