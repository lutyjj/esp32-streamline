import { useEffect, useState } from 'preact/hooks';
import { copyText } from '../lib/adminKey';
import { apiClient, unwrap } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { toast } from '../state/toasts';

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
};

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string }>;
};

type ApiDocument = {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, { get?: Operation; post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};

type ApiOperation = {
  method: 'GET' | 'POST';
  path: string;
  operation: Operation;
};

export function ApiTab() {
  const [document, setDocument] = useState<ApiDocument>();
  const [failure, setFailure] = useState('');

  useEffect(() => {
    unwrap(apiClient.GET('/api/openapi.json'))
      .then((value) => setDocument(value as ApiDocument))
      .catch((error) => setFailure(errorMessage(error)));
  }, []);

  if (failure) {
    return <div class="card">Could not load the API contract: {failure}</div>;
  }
  if (!document) return <div class="card">Loading the device API contract…</div>;

  const operations = collectOperations(document);
  return (
    <>
      <div class="card api-intro">
        <div>
          <h2>{document.info?.title ?? 'Device API'}</h2>
          <p class="lead">
            OpenAPI {document.info?.version ?? '1.0'} · {operations.length} operations · writes use
            the admin key as a bearer token
          </p>
        </div>
        <a class="btn secondary" href="/api/openapi.json" target="_blank" rel="noreferrer">
          Open JSON
        </a>
      </div>
      <div class="api-list">
        {operations.map(({ method, path, operation }) => (
          <OperationCard
            key={`${method}:${path}`}
            method={method}
            path={path}
            operation={operation}
            document={document}
          />
        ))}
      </div>
    </>
  );
}

function OperationCard({
  method,
  path,
  operation,
  document,
}: ApiOperation & { document: ApiDocument }) {
  const body = requestSchema(operation, document);
  const required = new Set(body?.required ?? []);
  const command = curlCommand(method, path, operation, body);
  return (
    <details class="api-operation">
      <summary>
        <span class={`api-method ${method.toLowerCase()}`}>{method}</span>
        <code class="api-path">{path}</code>
        <span>{operation.summary ?? words(operation.operationId)}</span>
        {operation.security && <span class="api-auth">key</span>}
      </summary>
      <div class="api-detail">
        {operation.description && <p>{operation.description}</p>}
        {body?.properties && (
          <div class="api-fields">
            <h3>Form fields</h3>
            <div class="api-field api-field-header" aria-hidden="true">
              <span>Parameter</span>
              <span>Type</span>
              <span>Presence</span>
              <span>Description</span>
            </div>
            {Object.entries(body.properties).map(([name, schema]) => (
              <div class="api-field" key={name}>
                <code>{name}</code>
                <span>{schemaType(schema)}</span>
                <span class={required.has(name) ? 'api-field-required' : 'api-field-optional'}>
                  {required.has(name) ? 'required' : 'optional'}
                </span>
                <small>{constraint(schema)}</small>
              </div>
            ))}
          </div>
        )}
        <div class="api-responses">
          <h3>Responses</h3>
          {Object.keys(operation.responses ?? {}).map((status) => (
            <code key={status}>{status}</code>
          ))}
        </div>
        <div class="api-example">
          <div>
            <h3>curl</h3>
            <button
              class="btn secondary api-copy"
              type="button"
              onClick={() =>
                copyText(command).then(
                  () => toast('curl command copied', 'ok'),
                  (error) => toast(errorMessage(error), 'err'),
                )
              }
            >
              Copy
            </button>
          </div>
          <pre>{command}</pre>
        </div>
      </div>
    </details>
  );
}

function collectOperations(document: ApiDocument): ApiOperation[] {
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (item.get) operations.push({ method: 'GET', path, operation: item.get });
    if (item.post) operations.push({ method: 'POST', path, operation: item.post });
  }
  return operations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

function requestSchema(operation: Operation, document: ApiDocument): Schema | undefined {
  const media = operation.requestBody?.content?.['application/x-www-form-urlencoded'];
  const schema = media?.schema;
  const name = schema?.$ref?.split('/').at(-1);
  return name ? document.components?.schemas?.[name] : schema;
}

function constraint(schema: Schema): string {
  const values = [
    schema.description,
    schema.format,
    schema.minimum !== undefined ? `min ${schema.minimum}` : '',
    schema.maximum !== undefined ? `max ${schema.maximum}` : '',
    schema.minLength !== undefined ? `min length ${schema.minLength}` : '',
    schema.maxLength !== undefined ? `max length ${schema.maxLength}` : '',
    schema.pattern ? `pattern ${schema.pattern}` : '',
  ];
  return values.filter(Boolean).join(' · ');
}

function schemaType(schema: Schema): string {
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'value';
}

function curlCommand(method: 'GET' | 'POST', path: string, operation: Operation, body?: Schema) {
  const origin = window.location.origin;
  const lines = [`curl${method === 'POST' ? ' -X POST' : ''}`];
  if (operation.security) lines.push(`  -H 'Authorization: Bearer $STREAMLINE_ADMIN_KEY'`);
  for (const name of Object.keys(body?.properties ?? {})) {
    lines.push(`  --data-urlencode '${name}=<value>'`);
  }
  lines.push(`  '${origin}${path}'`);
  return lines.join(' \\\n');
}

function words(value?: string) {
  return value ? value.replaceAll('_', ' ') : '';
}
