import { useEffect, useMemo, useState } from 'preact/hooks';
import { getOpenApi, type OpenApiDocument } from '../lib/api';
import { Kv } from './Kv';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];
type RecordValue = Record<string, unknown>;

export interface ApiOperation {
  path: string;
  method: HttpMethod;
  summary: string;
  operationId: string;
  secured: boolean;
  requestContent: string[];
  requestFields: string[];
  responses: string[];
}

export function ApiTab() {
  const [spec, setSpec] = useState<OpenApiDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getOpenApi()
      .then((document) => {
        if (cancelled) return;
        setSpec(document);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const operations = useMemo(() => (spec ? collectOperations(spec) : []), [spec]);

  return (
    <>
      <div class="card">
        <h2>API</h2>
        <p class="lead">
          {spec ? `${spec.info.title} · v${spec.info.version}` : 'Loading API contract…'}
        </p>
        <div class="cardfoot" style="border:0;padding:0;margin-top:12px">
          <span class="actionstate">
            JSON at <code>/api/openapi.json</code>
          </span>
        </div>
      </div>

      {error && (
        <div class="card">
          <h2>API unavailable</h2>
          <p class="lead">{error}</p>
        </div>
      )}

      {operations.map((operation) => (
        <div class="card apiendpoint" key={`${operation.method}:${operation.path}`}>
          <div class="apihead">
            <span class={`method ${operation.method}`}>{operation.method.toUpperCase()}</span>
            <code>{operation.path}</code>
          </div>
          <p class="lead">{operation.summary || operation.operationId}</p>
          <Kv
            rows={[
              ['Operation', operation.operationId || '—'],
              ['Auth', operation.secured ? 'admin key' : 'open'],
              ['Request', operation.requestContent.join(', ') || 'none'],
              ['Fields', operation.requestFields.join(', ') || 'none'],
              ['Responses', operation.responses.join(', ') || '—'],
            ]}
          />
        </div>
      ))}
    </>
  );
}

export function collectOperations(spec: OpenApiDocument): ApiOperation[] {
  return Object.entries(spec.paths).flatMap(([path, pathItem]) => {
    const item = object(pathItem);
    if (!item) return [];
    return HTTP_METHODS.flatMap((method) => {
      const operation = object(item[method]);
      if (!operation) return [];
      const requestContent = requestMediaTypes(operation);
      return [
        {
          path,
          method,
          summary: stringValue(operation.summary),
          operationId: stringValue(operation.operationId),
          secured: Array.isArray(operation.security) && operation.security.length > 0,
          requestContent,
          requestFields: requestFieldNames(spec, operation),
          responses: responseCodes(operation),
        },
      ];
    });
  });
}

function requestMediaTypes(operation: RecordValue): string[] {
  const requestBody = object(operation.requestBody);
  const content = object(requestBody?.content);
  return content ? Object.keys(content) : [];
}

function requestFieldNames(spec: OpenApiDocument, operation: RecordValue): string[] {
  const requestBody = object(operation.requestBody);
  const content = object(requestBody?.content);
  if (!content) return [];
  const schema = Object.values(content)
    .map((entry) => object(entry))
    .map((entry) => object(entry?.schema))
    .find((entry) => entry !== null);
  const resolved = schema ? resolveSchema(spec, schema) : null;
  const properties = object(resolved?.properties);
  if (!properties) return [];
  const required = arrayOfStrings(resolved?.required);
  return Object.keys(properties).map((name) => (required.includes(name) ? `${name}*` : name));
}

function responseCodes(operation: RecordValue): string[] {
  const responses = object(operation.responses);
  if (!responses) return [];
  return Object.keys(responses).sort((a, b) => Number(a) - Number(b));
}

function resolveSchema(spec: OpenApiDocument, schema: RecordValue): RecordValue {
  const ref = stringValue(schema.$ref);
  if (!ref.startsWith('#/components/schemas/')) return schema;
  const name = ref.slice('#/components/schemas/'.length);
  const root = spec as RecordValue;
  const components = object(root.components);
  const schemas = object(components?.schemas);
  return object(schemas?.[name]) ?? schema;
}

function object(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
