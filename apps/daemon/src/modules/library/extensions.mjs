import { digest } from '../../../../../packages/runner/src/index.mjs';

const text = (value, label, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid extension ${label}.`);
  return value.trim();
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Extension ${label} must be an object.`);
  return value;
};

/**
 * Validates reviewed declarative extension metadata. It deliberately accepts
 * no code, credentials, endpoint URLs, or runner shell command: adapters own
 * transport and execution, while this revision is safe to audit and pin.
 */
export function parseExtensionManifest(value) {
  const manifest = object(value, 'manifest');
  const allowed = new Set(['id', 'kind', 'revision', 'execution', 'tools']);
  const extra = Object.keys(manifest).find((key) => !allowed.has(key));
  if (extra) throw new Error(`Unsupported extension field: ${extra}.`);
  const id = text(manifest.id, 'ID', 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw new Error('Extension IDs use lowercase letters, numbers and single hyphens.');
  if (!['mcp', 'executor'].includes(manifest.kind)) throw new Error('Extension kind must be mcp or executor.');
  const revision = text(manifest.revision, 'revision', 128);
  if (!/^[a-zA-Z0-9._:-]+$/.test(revision)) throw new Error('Extension revision is not immutable-safe.');
  const execution = object(manifest.execution, 'execution');
  if (Object.keys(execution).some((key) => !['location', 'adapter'].includes(key)))
    throw new Error('Extension execution only declares location and adapter.');
  if (!['runner'].includes(execution.location)) throw new Error('Extensions must execute on an assigned runner.');
  const adapter = text(execution.adapter, 'adapter', 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9-]*[a-z0-9])?$/.test(adapter))
    throw new Error('Extension adapter is invalid.');
  if (!Array.isArray(manifest.tools) || !manifest.tools.length || manifest.tools.length > 50)
    throw new Error('An extension needs 1-50 tools.');
  const tools = manifest.tools.map((tool) => {
    const entry = object(tool, 'tool');
    if (Object.keys(entry).some((key) => !['id', 'name', 'description', 'inputSchema', 'approval'].includes(key)))
      throw new Error('Unsupported extension tool field.');
    const toolId = text(entry.id, 'tool ID', 120);
    const name = text(entry.name, 'tool name', 120);
    const description = text(entry.description, 'tool description', 2000);
    if (!['none', 'ask'].includes(entry.approval)) throw new Error('Extension tool approval must be none or ask.');
    const inputSchema = object(entry.inputSchema, 'tool input schema');
    if (JSON.stringify(inputSchema).length > 50_000) throw new Error('Extension tool schema is oversized.');
    return { id: toolId, name, description, inputSchema: structuredClone(inputSchema), approval: entry.approval };
  });
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
    throw new Error('Extension tool IDs must be unique.');
  return {
    id,
    kind: manifest.kind,
    revision,
    execution: { location: 'runner', adapter },
    tools,
    hash: digest(JSON.stringify({ id, kind: manifest.kind, revision, execution: { location: 'runner', adapter }, tools })),
  };
}

export function migrateExtensionState(state) {
  state.extensions ??= [];
}
