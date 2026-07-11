import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ApiDocument, audioProfileConstraints, resolveSchema } from '../src/lib/contract';

const doc: ApiDocument = {
  components: {
    schemas: {
      AudioProfileCatalog: {
        properties: {
          profiles: {
            type: 'array',
            maxItems: 8,
            items: { $ref: '#/components/schemas/AudioProfile' },
          },
        },
      },
      AudioProfile: {
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 32 },
          name: { type: 'string', maxLength: 32 },
        },
      },
    },
  },
};

describe('contract reader', () => {
  it('follows a $ref to the named schema', () => {
    expect(resolveSchema(doc, { $ref: '#/components/schemas/AudioProfile' })).toBe(
      doc.components?.schemas?.AudioProfile,
    );
    expect(resolveSchema(doc, { type: 'string' })).toEqual({ type: 'string' });
  });

  it('reads the audio-profile import limits declared on the schema', () => {
    expect(audioProfileConstraints(doc)).toEqual({
      maxProfiles: 8,
      idPattern: '^[a-z0-9][a-z0-9-]*$',
      idMaxChars: 32,
      nameMaxChars: 32,
    });
  });

  it('fails loudly when the contract omits a declared limit', () => {
    const stripped: ApiDocument = {
      components: {
        schemas: {
          ...doc.components?.schemas,
          AudioProfileCatalog: { properties: { profiles: { type: 'array' } } },
        },
      },
    };
    expect(() => audioProfileConstraints(stripped)).toThrow(/profile count limit/);
  });

  it('matches the generated device contract', () => {
    // vitest runs with the console package as its working directory.
    const generated = JSON.parse(
      readFileSync(resolve('../docs/openapi.json'), 'utf8'),
    ) as ApiDocument;
    expect(audioProfileConstraints(generated)).toEqual({
      maxProfiles: 8,
      idPattern: '^[a-z0-9][a-z0-9-]*$',
      idMaxChars: 32,
      nameMaxChars: 32,
    });
  });
});
