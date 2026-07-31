import { useEffect, useState } from 'preact/hooks';
import { getContract } from '../lib/api';
import {
  type ApiDocument,
  type ApiPathOperation,
  type ApiSchema,
  resolveSchema,
} from '../lib/contract';
import { errorMessage } from '../lib/errors';
import { Card } from './Card';
import { CopyButton } from './CopyButton';

type OperationEntry = {
  method: 'GET' | 'POST';
  path: string;
  operation: ApiPathOperation;
};

export function ApiTab() {
  const [document, setDocument] = useState<ApiDocument>();
  const [failure, setFailure] = useState('');

  useEffect(() => {
    getContract()
      .then(setDocument)
      .catch((error) => setFailure(errorMessage(error)));
  }, []);

  if (failure) {
    return <Card>Could not load the API contract: {failure}</Card>;
  }
  if (!document) return <Card>Loading the device API contract…</Card>;

  const operations = collectOperations(document);
  return (
    <>
      <Card className="api-intro">
        <div>
          <h2>{document.info?.title ?? 'Device API'}</h2>
          <p class="lead">
            Contract v{document.info?.version ?? '1.0'} · {operations.length} operations · writes
            use the admin key as a bearer token
          </p>
        </div>
        <a class="btn secondary" href="/api/openapi.json" target="_blank" rel="noreferrer">
          Open JSON
        </a>
      </Card>
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
}: OperationEntry & { document: ApiDocument }) {
  const body = requestSchema(operation, document);
  const required = new Set(body?.required ?? []);
  const command = curlCommand(method, path, operation, body);
  return (
    <details class="api-operation">
      <summary>
        <span class={`api-method ${method.toLowerCase()}`}>{method}</span>
        <code class="api-path">{path}</code>
        <span>{operation.summary ?? words(operation.operationId)}</span>
        <span class="api-auth-slot">{operation.security && <span class="api-auth">key</span>}</span>
      </summary>
      <div class="api-detail">
        {operation.description && <p>{operation.description}</p>}
        {body?.properties && (
          <div class="api-fields">
            <h3>Form fields</h3>
            <div class="api-field api-field-header" aria-hidden="true">
              <span>Parameter and type</span>
              <span>Presence</span>
              <span>Description</span>
            </div>
            {Object.entries(body.properties).map(([name, schema]) => (
              <div class="api-field" key={name}>
                <div class="api-field-main">
                  <code>{name}</code>
                  <span>{schemaType(schema)}</span>
                </div>
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
            <CopyButton className="api-copy" value={command} copied="curl command copied">
              Copy
            </CopyButton>
          </div>
          <pre>{command}</pre>
        </div>
      </div>
    </details>
  );
}

function collectOperations(document: ApiDocument): OperationEntry[] {
  const operations: OperationEntry[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (item.get) operations.push({ method: 'GET', path, operation: item.get });
    if (item.post) operations.push({ method: 'POST', path, operation: item.post });
  }
  return operations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

function requestSchema(operation: ApiPathOperation, document: ApiDocument): ApiSchema | undefined {
  const media = operation.requestBody?.content?.['application/x-www-form-urlencoded'];
  return resolveSchema(document, media?.schema);
}

function constraint(schema: ApiSchema): string {
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

function schemaType(schema: ApiSchema): string {
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'value';
}

/**
 * A safe, dispatchable example: `--digest` has curl answer the device's
 * challenge itself, the credential is double-quoted so a real shell expands
 * the environment token, and only required fields appear — optional ones are
 * documented in the table above, never invented as live values (a blank
 * optional pair can change an operation's meaning, e.g. a custom OTA
 * collapsing into a release install).
 */
export function curlCommand(
  method: 'GET' | 'POST',
  path: string,
  operation: ApiPathOperation,
  body?: ApiSchema,
  origin: string = window.location.origin,
) {
  const lines = [`curl${method === 'POST' ? ' -X POST' : ''}`];
  if (operation.security) lines.push(`  --digest -u "admin:$STREAMLINE_ADMIN_KEY"`);
  const required = new Set(body?.required ?? []);
  for (const [name, schema] of Object.entries(body?.properties ?? {})) {
    if (!required.has(name)) continue;
    lines.push(`  --data-urlencode '${name}=${placeholderFor(name, schema)}'`);
  }
  lines.push(`  '${origin}${path}'`);
  return lines.join(' \\\n');
}

/** A value satisfying the field's own constraints where the schema names one,
 *  else a clearly-a-placeholder token. */
function placeholderFor(name: string, schema: ApiSchema): string {
  if (schema.enum?.length) return String(schema.enum[0]);
  if (schema.minimum !== undefined) return String(schema.minimum);
  return `<${name}>`;
}

function words(value?: string) {
  return value ? value.replaceAll('_', ' ') : '';
}
