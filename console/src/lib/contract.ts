/**
 * Reads the device-served OpenAPI contract. The device owns every shape and
 * limit; the console renders and validates from this document rather than
 * restating device facts, so a new constrained field needs no console change.
 */

export interface ApiSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  enum?: unknown[];
  items?: ApiSchema;
  properties?: Record<string, ApiSchema>;
  required?: string[];
}

export interface ApiPathOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  requestBody?: { content?: Record<string, { schema?: ApiSchema }> };
  responses?: Record<string, { description?: string }>;
}

export interface ApiDocument {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, { get?: ApiPathOperation; post?: ApiPathOperation }>;
  components?: { schemas?: Record<string, ApiSchema> };
}

const REF_PREFIX = '#/components/schemas/';

/** Follow a local `$ref` to the schema it names; pass inline schemas through. */
export function resolveSchema(doc: ApiDocument, schema?: ApiSchema): ApiSchema | undefined {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith(REF_PREFIX)) return undefined;
  return doc.components?.schemas?.[schema.$ref.slice(REF_PREFIX.length)];
}

/** The audio-profile import limits the device declares on its schema. */
export interface AudioProfileConstraints {
  maxProfiles: number;
  idPattern: string;
  idMinChars: number;
  idMaxChars: number;
  nameMaxChars: number;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`device contract is missing ${what}`);
  return value;
}

export function audioProfileConstraints(doc: ApiDocument): AudioProfileConstraints {
  const profiles = doc.components?.schemas?.AudioProfileCatalog?.properties?.profiles;
  const profile = resolveSchema(doc, profiles?.items);
  const id = profile?.properties?.id;
  const name = profile?.properties?.name;
  return {
    maxProfiles: required(profiles?.maxItems, 'the audio profile count limit'),
    idPattern: required(id?.pattern, 'the audio profile id pattern'),
    idMinChars: id?.minLength ?? 0,
    idMaxChars: required(id?.maxLength, 'the audio profile id length limit'),
    nameMaxChars: required(name?.maxLength, 'the audio profile name length limit'),
  };
}
