import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBridge } from '../src/mocks/bridge';
import { FakeDevice } from '../src/mocks/device';

/**
 * Every operation in a console's OpenAPI document must have a mock handler,
 * and every handler must be a contract operation — the console-side mirror
 * of the firmware's `ENDPOINTS` drift test. A new endpoint without a mock
 * fails here.
 */

interface ApiPaths {
  paths: Record<string, Record<string, unknown>>;
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/** Contract operations as "METHOD /path", with `{param}` in MSW's `:param` form. */
function contractOperations(document: string): string[] {
  // vitest runs with the console package as its working directory.
  const api = JSON.parse(readFileSync(resolve('..', 'docs', document), 'utf8')) as ApiPaths;
  return Object.entries(api.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => METHODS.includes(method))
      .map(
        (method) =>
          `${method.toUpperCase()} ${path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => `:${camel(name)}`)}`,
      ),
  );
}

/** MSW route params are camelCase where the contract uses snake_case. */
function camel(name: string): string {
  return name.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function handlerOperations(handlers: { info: { method: unknown; path: unknown } }[]): string[] {
  return handlers.map((handler) => `${String(handler.info.method)} ${String(handler.info.path)}`);
}

describe('mock contract coverage', () => {
  it('handles every device operation, and nothing else', () => {
    expect(handlerOperations(new FakeDevice().handlers).sort()).toEqual(
      contractOperations('openapi.json').sort(),
    );
  });

  it('handles every bridge operation, and nothing else', () => {
    expect(handlerOperations(new FakeBridge().handlers).sort()).toEqual(
      contractOperations('bridge-openapi.json').sort(),
    );
  });
});
