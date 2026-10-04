import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/workflows/workflow-authoring.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  parseActivityJsonEdit,
  parseRunInputSchemaEdit,
  parseWorkflowJsonEdit,
  activityBindingSourceKey,
  activityBindingSelectionValue,
  activityBindingSourceIsAvailable,
  declaredObjectPaths,
  activityEnumOptionIndex,
  activityEnumValueAt,
  activityPinIsStale,
  changedActivityPin,
  replaceWorkflowBranchRevision,
  activityPermissionEditor,
  activityDeclaresWorkflowTools,
  workflowPermissionIsUnavailable,
  workflowPermissionOptions,
} = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('JSON authoring keeps invalid intermediate text out of the configured value and accepts valid nested values', () => {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { amount: { type: 'number' }, enabled: { type: 'boolean' } },
          required: ['amount', 'enabled'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
  assert.deepEqual(parseActivityJsonEdit('{"items":[', schema), { error: 'Enter valid JSON.' });
  assert.deepEqual(parseActivityJsonEdit('{"items":[{"amount":2,"enabled":true}]}', schema), {
    value: { items: [{ amount: 2, enabled: true }] },
  });
  assert.match(
    parseActivityJsonEdit('{"items":[{"amount":"2","enabled":true}]}', schema).error,
    /items\[0\]\.amount must be a number/,
  );
});

test('run-input JSON editor rejects invalid schema drafts instead of accepting the previous schema', () => {
  assert.deepEqual(parseRunInputSchemaEdit('{'), { error: 'Enter a valid JSON schema.' });
  assert.match(
    parseRunInputSchemaEdit('{"type":"string","properties":{}}').error,
    /must be a JSON object schema/,
  );
  assert.deepEqual(
    parseRunInputSchemaEdit(
      '{"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"]}',
    ),
    {
      value: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
    },
  );
  assert.match(
    parseRunInputSchemaEdit('{"type":"object","properties":{"amount":{"type":"money"}}}').error,
    /unsupported type/,
  );
});

test('composition JSON drafts are bounded and reject reserved property paths', () => {
  assert.deepEqual(parseWorkflowJsonEdit('{'), { error: 'Enter valid JSON.' });
  assert.deepEqual(parseWorkflowJsonEdit('{"safe":{"amount":2}}'), {
    value: { safe: { amount: 2 } },
  });
  assert.match(parseWorkflowJsonEdit('{"__proto__":{"unsafe":true}}').error, /reserved field/);
  assert.match(parseWorkflowJsonEdit('"x"'.padEnd(128_001, ' ')).error, /editor limit/);
  assert.match(
    parseWorkflowJsonEdit(JSON.stringify({ values: Array(257).fill(1) })).error,
    /array exceeds/,
  );
});

test('binding source identity retains exact declared path elements and activity revisions', () => {
  const binding = { from: { kind: 'run_input', path: ['vendor.code', 'approval'] } };
  assert.equal(activityBindingSourceKey(binding), JSON.stringify(binding.from));
  assert.equal(activityBindingSelectionValue(undefined), 'omit');
  assert.equal(activityBindingSelectionValue({ literal: null }), 'literal');
  assert.deepEqual(parseActivityJsonEdit('null', { type: 'null' }), { value: null });
  assert.equal(
    changedActivityPin(
      { id: 'data.consume-summary', revision: 1 },
      { id: 'data.consume-summary', revision: 1 },
    ),
    false,
  );
  assert.equal(
    changedActivityPin(
      { id: 'data.consume-summary', revision: 1 },
      { id: 'data.consume-summary', revision: 2 },
    ),
    true,
  );
});

test('branch revision edits clear only pins bound to the old exact revision', () => {
  const branch = {
    id: 'vendor-check',
    workflow: { id: 'procure-assess', version: 2 },
    workflowDigest: 'workflow-pin',
    inputSchemaDigest: 'input-pin',
    resultSchemaDigest: 'result-pin',
    inputBindings: { amount: { literal: 12.5 } },
    outputBindings: { approved: { from: ['approved'] } },
  };
  const unchanged = replaceWorkflowBranchRevision(branch, { id: 'procure-assess', version: 2 });
  assert.deepEqual(unchanged, branch);

  const changed = replaceWorkflowBranchRevision(branch, { id: 'procure-assess', version: 3 });
  assert.deepEqual(changed.workflow, { id: 'procure-assess', version: 3 });
  assert.equal('workflowDigest' in changed, false);
  assert.equal('inputSchemaDigest' in changed, false);
  assert.equal('resultSchemaDigest' in changed, false);
  assert.deepEqual(changed.inputBindings, branch.inputBindings);
  assert.deepEqual(changed.outputBindings, branch.outputBindings);
});

test('nested object bindings are selectable while unlisted configured paths stay preserved', () => {
  const paths = declaredObjectPaths({
    type: 'object',
    properties: {
      payload: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          metadata: { type: 'object', properties: { approved: { type: 'boolean' } } },
          tags: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' } } },
          },
        },
      },
    },
  });
  assert.deepEqual(
    paths.map(({ path }) => path),
    [
      ['payload'],
      ['payload', 'amount'],
      ['payload', 'metadata'],
      ['payload', 'metadata', 'approved'],
      ['payload', 'tags'],
    ],
  );
  const nested = { from: { kind: 'run_input', path: ['payload', 'amount'] } };
  assert.equal(
    activityBindingSourceIsAvailable(
      nested,
      paths.map(({ path }) => ({ from: { kind: 'run_input', path } })),
    ),
    true,
  );
  const configuredArrayItem = {
    from: { kind: 'run_input', path: ['payload', 'tags', '0', 'label'] },
  };
  const available = paths.map(({ path }) => ({ from: { kind: 'run_input', path } }));
  assert.equal(activityBindingSourceIsAvailable(configuredArrayItem, available), false);
  assert.equal(
    activityBindingSelectionValue(configuredArrayItem),
    JSON.stringify(configuredArrayItem.from),
  );
  assert.equal(
    declaredObjectPaths(
      {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 400 }, (_, index) => [`field${index}`, { type: 'string' }]),
        ),
      },
      32,
    ).length,
    32,
  );
  const maliciousProperties = JSON.parse(
    '{"safe":{"type":"string"},"__proto__":{"type":"object","properties":{"polluted":{"type":"string"}}},"constructor":{"type":"string"},"prototype":{"type":"string"}}',
  );
  assert.deepEqual(
    declaredObjectPaths({ type: 'object', properties: maliciousProperties }).map(
      ({ path }) => path,
    ),
    [['safe']],
  );
  const inheritedProperties = Object.create({ inherited: { type: 'string' } });
  inheritedProperties.own = { type: 'string' };
  assert.deepEqual(
    declaredObjectPaths({ type: 'object', properties: inheritedProperties }).map(
      ({ path }) => path,
    ),
    [['own']],
  );
});

test('enum option identity preserves null and structured JSON values without string collisions', () => {
  const values = [null, { b: 2, a: 1 }, '[object Object]'];
  assert.equal(activityEnumOptionIndex(values, null), '0');
  assert.equal(activityEnumValueAt(values, '0'), null);
  assert.equal(activityEnumOptionIndex(values, { a: 1, b: 2 }), '1');
  assert.deepEqual(activityEnumValueAt(values, '1'), { b: 2, a: 1 });
  assert.equal(activityEnumOptionIndex(values, '[object Object]'), '2');
  assert.notEqual(
    activityEnumOptionIndex(values, { a: 1, b: 2 }),
    activityEnumOptionIndex(values, '[object Object]'),
  );
  assert.equal(activityEnumValueAt(values, ''), undefined);
});

test('a selected activity pin is stale only when both authoritative digests exist and differ', () => {
  assert.equal(activityPinIsStale('a'.repeat(64), 'b'.repeat(64)), true);
  assert.equal(activityPinIsStale('a'.repeat(64), 'a'.repeat(64)), false);
  assert.equal(activityPinIsStale(undefined, 'b'.repeat(64)), false);
  assert.equal(activityPinIsStale('a'.repeat(64), undefined), false);
});

test('agent workflow permission controls follow declared resources and retain an unavailable stored choice', () => {
  assert.deepEqual(
    workflowPermissionOptions.map(([permission]) => permission),
    ['none', 'read', 'read-write', 'full'],
  );
  assert.equal(
    activityDeclaresWorkflowTools({
      resources: { location: 'agent', provider: 'required', tools: ['read_file'] },
    }),
    true,
  );
  assert.equal(
    activityDeclaresWorkflowTools({
      resources: { location: 'agent', provider: 'required', workspace: true },
    }),
    true,
  );
  assert.equal(
    activityDeclaresWorkflowTools({ resources: { location: 'agent', provider: 'required' } }),
    false,
  );
  for (const location of ['daemon', 'runner', 'integration'])
    assert.equal(activityDeclaresWorkflowTools({ resources: { location } }), false);
  assert.equal(workflowPermissionIsUnavailable('none'), false);
  assert.equal(workflowPermissionIsUnavailable('read-write'), false);
  assert.equal(workflowPermissionIsUnavailable('workspace-admin'), true);
  assert.equal(workflowPermissionIsUnavailable(undefined), false);
  const agentTools = {
    resources: { location: 'agent', provider: 'required', tools: ['read_file'] },
  };
  assert.equal(activityPermissionEditor({ resources: { location: 'daemon' } }, 'full'), null);
  assert.equal(
    activityPermissionEditor({ resources: { location: 'agent', provider: 'required' } }, 'full'),
    null,
  );
  assert.equal(activityPermissionEditor(agentTools, 'read-write').value, 'read-write');
  assert.equal(activityPermissionEditor(agentTools, 'none').value, 'none');
  assert.deepEqual(activityPermissionEditor(agentTools, 'workspace-admin').options[0], {
    value: 'workspace-admin',
    label: 'workspace-admin · unavailable',
    disabled: true,
  });
});
