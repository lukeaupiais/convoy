import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const selectorPattern = /^\$(?:\.[A-Za-z_][\w-]*|\[\d+\])*$/;
const allowedPriorities = new Set(['Low', 'Medium', 'High']);

function object(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function keys(value, allowed, message) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${message}: ${extra}.`);
}

function requiredString(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be non-empty text no longer than ${max} characters.`);
  return value.trim();
}

function selector(value, name) {
  const selected = requiredString(value, name, 200);
  if (!selectorPattern.test(selected)) throw new Error(`${name} uses an unsupported selector.`);
  return selected;
}

function endpointUrl(baseUrl, path, variables = {}) {
  const rendered = requiredString(path, 'Operation path', 1000).replace(
    /\$\{(remoteId|cursor|limit)\}/g,
    (_match, key) => encodeURIComponent(String(variables[key] ?? '')),
  );
  if (/\$\{/.test(rendered)) throw new Error('Operation path contains an unsupported template variable.');
  const url = new URL(rendered, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin) throw new Error('Operation path must remain under the configured origin.');
  return url;
}

function addressIsPrivate(address) {
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  if (!address.includes('.')) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

async function assertDestination(url, resolver, allowedPrivateOrigins) {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    throw new Error('Custom ticket sources require HTTPS outside loopback development.');
  if (allowedPrivateOrigins.has(url.origin)) return;
  if (url.hostname === 'localhost' || isIP(url.hostname) && addressIsPrivate(url.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('Custom ticket source destination is private and is not allowed by this deployment.');
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => addressIsPrivate(entry.address)))
    throw new Error('Custom ticket source resolved to a private or unavailable destination.');
}

function readSelector(input, expression) {
  if (expression === '$') return input;
  let value = input;
  const parts = expression.slice(1).match(/\.[A-Za-z_][\w-]*|\[\d+\]/g) ?? [];
  for (const part of parts) {
    const key = part[0] === '.' ? part.slice(1) : Number(part.slice(1, -1));
    value = value?.[key];
  }
  return value;
}

function mappedString(item, expression, name, max, optional = false) {
  const raw = readSelector(item, expression);
  if (optional && (raw === undefined || raw === null || raw === '')) return undefined;
  return requiredString(String(raw ?? ''), name, max);
}

function mapValue(values, field, raw) {
  if (raw === undefined) return undefined;
  const mapping = values?.[field];
  if (!mapping) return String(raw);
  if (!Object.hasOwn(mapping, String(raw))) throw new Error(`Remote ${field} value is not mapped: ${String(raw)}.`);
  return mapping[String(raw)];
}

export function validateCustomTicketSourceManifest(input) {
  const manifest = structuredClone(object(input, 'Custom ticket source manifest must be an object.'));
  keys(manifest, ['apiVersion', 'kind', 'metadata', 'connection', 'operations', 'mapping', 'values', 'ownership'], 'Unknown manifest field');
  if (manifest.apiVersion !== 'convoy.dev/v1alpha1' || manifest.kind !== 'TicketSource')
    throw new Error('Custom ticket source manifest version or kind is unsupported.');
  if (manifest.metadata !== undefined) {
    object(manifest.metadata, 'Manifest metadata must be an object.');
    keys(manifest.metadata, ['name'], 'Unknown metadata field');
    requiredString(manifest.metadata.name, 'Manifest metadata name', 100);
  }
  const connection = object(manifest.connection, 'Manifest connection is required.');
  keys(connection, ['baseUrl', 'authentication'], 'Unknown connection field');
  const base = new URL(requiredString(connection.baseUrl, 'Base URL', 1000));
  if (base.username || base.password || base.search || base.hash) throw new Error('Base URL cannot contain credentials, query, or fragment.');
  connection.baseUrl = base.href.replace(/\/$/, '');
  const authentication = object(connection.authentication, 'Manifest authentication is required.');
  keys(authentication, ['type', 'credential', 'header'], 'Unknown authentication field');
  if (!['bearer', 'header'].includes(authentication.type)) throw new Error('Authentication type must be bearer or header.');
  const credentialReference = requiredString(authentication.credential, 'Credential reference', 100);
  if (!/^CONVOY_TICKET_SOURCE_[A-Z0-9_]{1,72}$/.test(credentialReference))
    throw new Error('Credential reference must start with CONVOY_TICKET_SOURCE_.');
  if (authentication.type === 'header') {
    const header = requiredString(authentication.header, 'Authentication header', 80).toLowerCase();
    if (!/^x-[a-z0-9-]+$/.test(header)) throw new Error('Static authentication must use an X- prefixed header.');
    authentication.header = header;
  } else if (authentication.header !== undefined) throw new Error('Bearer authentication cannot define a header.');
  const operations = object(manifest.operations, 'Manifest operations are required.');
  keys(operations, ['list', 'get'], 'Unknown operation');
  for (const [name, required] of [['list', true], ['get', false]]) {
    if (!operations[name]) { if (required) throw new Error('List operation is required.'); else continue; }
    const operation = object(operations[name], `${name} operation must be an object.`);
    keys(operation, ['method', 'path', 'query', 'response'], `Unknown ${name} operation field`);
    if (operation.method !== 'GET') throw new Error(`${name} operation must use GET.`);
    endpointUrl(connection.baseUrl, operation.path, { remoteId: 'id', cursor: 'cursor', limit: 1 });
    if (operation.query !== undefined) {
      object(operation.query, `${name} query must be an object.`);
      if (Object.keys(operation.query).length > 20) throw new Error(`${name} query has too many parameters.`);
      for (const [key, value] of Object.entries(operation.query)) {
        if (!/^[A-Za-z_][\w.-]{0,79}$/.test(key) || typeof value !== 'string' || !/^\$\{(?:cursor|limit|remoteId)\}$/.test(value))
          throw new Error(`${name} query parameter is unsupported.`);
      }
    }
    const response = object(operation.response, `${name} response mapping is required.`);
    keys(response, name === 'list' ? ['items', 'nextCursor'] : ['item'], `Unknown ${name} response field`);
    selector(response[name === 'list' ? 'items' : 'item'], `${name} response selector`);
    if (response.nextCursor !== undefined) selector(response.nextCursor, 'Next cursor selector');
  }
  const mapping = object(manifest.mapping, 'Manifest mapping is required.');
  keys(mapping, ['remoteId', 'remoteKey', 'title', 'description', 'status', 'priority', 'remoteVersion', 'updatedAt', 'url'], 'Unknown mapping field');
  for (const name of ['remoteId', 'remoteKey', 'title', 'remoteVersion']) selector(mapping[name], `${name} selector`);
  for (const name of ['description', 'status', 'priority', 'updatedAt', 'url']) if (mapping[name] !== undefined) selector(mapping[name], `${name} selector`);
  if (manifest.values !== undefined) {
    object(manifest.values, 'Value mappings must be an object.');
    keys(manifest.values, ['status', 'priority'], 'Unknown value mapping');
    for (const [field, values] of Object.entries(manifest.values)) {
      object(values, `${field} values must be an object.`);
      if (Object.keys(values).length > 100 || Object.values(values).some((value) => typeof value !== 'string' || !value || value.length > 80))
        throw new Error(`${field} value mapping is invalid.`);
    }
  }
  manifest.ownership ??= { title: 'external', description: 'external', status: 'external', priority: 'external' };
  object(manifest.ownership, 'Field ownership must be an object.');
  keys(manifest.ownership, ['title', 'description', 'status', 'priority'], 'Unknown ownership field');
  for (const field of ['title', 'description', 'status', 'priority']) {
    manifest.ownership[field] ??= 'external';
    if (!['external', 'convoy'].includes(manifest.ownership[field])) throw new Error(`${field} ownership is invalid.`);
  }
  return manifest;
}

function credential(connection, manifest) {
  const reference = manifest.connection.authentication.credential;
  const value = process.env[reference];
  if (!value) throw new Error(`Ticket source credential ${reference} is unavailable.`);
  return value;
}

function normalize(manifest, item) {
  object(item, 'Remote ticket must be an object.');
  const mapping = manifest.mapping;
  const statusRaw = mapping.status ? readSelector(item, mapping.status) : undefined;
  const priorityRaw = mapping.priority ? readSelector(item, mapping.priority) : undefined;
  const priority = mapValue(manifest.values, 'priority', priorityRaw);
  if (priority !== undefined && !allowedPriorities.has(priority)) throw new Error(`Mapped priority is unsupported: ${priority}.`);
  const urlValue = mapping.url ? mappedString(item, mapping.url, 'Remote URL', 2000, true) : undefined;
  let url;
  if (urlValue) {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Remote ticket URL must use HTTP or HTTPS.');
    url = parsed.href;
  }
  return {
    remoteId: mappedString(item, mapping.remoteId, 'Remote ID', 200),
    remoteKey: mappedString(item, mapping.remoteKey, 'Remote key', 200),
    title: mappedString(item, mapping.title, 'Remote title', 200),
    description: mapping.description ? mappedString(item, mapping.description, 'Remote description', 12000, true) ?? '' : '',
    status: mapValue(manifest.values, 'status', statusRaw),
    priority,
    remoteVersion: mappedString(item, mapping.remoteVersion, 'Remote version', 500),
    updatedAt: mapping.updatedAt ? mappedString(item, mapping.updatedAt, 'Remote updated time', 100, true) : undefined,
    url,
    fieldOwnership: manifest.ownership,
  };
}

export function createCustomTicketSource({ fetcher = fetch, resolver = lookup, allowedPrivateOrigins = [] } = {}) {
  const privateOrigins = new Set(allowedPrivateOrigins);
  async function readJson(response) {
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 2 * 1024 * 1024) {
        throw new Error('Ticket source response exceeds 2 MiB.');
      }
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Ticket source returned invalid JSON.'); }
  }
  async function request(connection, operationName, variables) {
    const manifest = validateCustomTicketSourceManifest(connection.manifest);
    const operation = manifest.operations[operationName];
    if (!operation) throw new Error(`Ticket source does not provide ${operationName}.`);
    const url = endpointUrl(manifest.connection.baseUrl, operation.path, variables);
    for (const [key, template] of Object.entries(operation.query ?? {})) {
      const variable = template.slice(2, -1);
      const value = variables[variable];
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    await assertDestination(url, resolver, privateOrigins);
    const secret = credential(connection, manifest);
    const auth = manifest.connection.authentication;
    const headers = { Accept: 'application/json' };
    headers[auth.type === 'bearer' ? 'Authorization' : auth.header] = auth.type === 'bearer' ? `Bearer ${secret}` : secret;
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Ticket source request failed (${response.status}).`);
    const type = response.headers?.get?.('content-type') ?? 'application/json';
    if (!type.toLowerCase().startsWith('application/json')) throw new Error('Ticket source returned a non-JSON response.');
    const body = await readJson(response);
    return { manifest, operation, body };
  }
  return {
    validateConnection(connection) { return validateCustomTicketSourceManifest(connection.manifest); },
    assertReady(connection) { validateCustomTicketSourceManifest(connection.manifest); credential(connection, connection.manifest); },
    async probe(connection) {
      const { manifest, operation, body } = await request(connection, 'list', { limit: 1 });
      const items = readSelector(body, operation.response.items);
      if (!Array.isArray(items)) throw new Error('Ticket source item selector did not return an array.');
      const sample = items[0] ? normalize(manifest, items[0]) : undefined;
      return { sourceName: connection.name, sample, itemCount: items.length };
    },
    async listIssues(connection, limit) {
      const { manifest, operation, body } = await request(connection, 'list', { limit });
      const items = readSelector(body, operation.response.items);
      if (!Array.isArray(items)) throw new Error('Ticket source item selector did not return an array.');
      if (items.length > limit || items.length > 100) throw new Error('Ticket source returned too many records.');
      return items.map((item) => normalize(manifest, item));
    },
    async getIssue(connection, remoteId) {
      const { manifest, operation, body } = await request(connection, 'get', { remoteId });
      return normalize(manifest, readSelector(body, operation.response.item));
    },
  };
}
