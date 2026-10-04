import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { activityDigest } from '../../apps/daemon/src/modules/workflows/activity-data.mjs';

async function fixture(t, { clock, extraActivities = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-example-'));
  const dispatches = [];
  const registrations = [
    {
      descriptor: {
        ref: { id: 'procurement.vendor-compliance', revision: 1 },
        inputSchema: { type: 'object', properties: { vendor: { type: 'object', properties: {
          name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
        }, required: ['name', 'country', 'quote'], additionalProperties: false } }, required: ['vendor'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 } }, required: ['eligible', 'basis'], additionalProperties: false },
        resources: { location: 'integration', adapterId: 'procurement-example' }, effect: 'pure', approval: { required: false },
        cancellation: 'immediate', confirmation: 'result', reconciliation: 'none', presentation: { label: 'Assess vendor compliance' },
      },
      implementation: {
        async prepare(input) { return structuredClone(input); },
        async dispatch(_context, input) {
          dispatches.push({ operation: 'compliance', input: structuredClone(input) });
          if (input.vendor.country === 'XX') throw new Error('Vendor record could not be assessed.');
          return { state: 'completed', output: { eligible: input.vendor.country !== 'XX', basis: `Country ${input.vendor.country}` } };
        },
      },
    },
    {
      descriptor: {
        ref: { id: 'procurement.quote-comparison', revision: 1 },
        inputSchema: { type: 'object', properties: { vendor: { type: 'object', properties: {
          name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
        }, required: ['name', 'country', 'quote'], additionalProperties: false } }, required: ['vendor'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { withinBudget: { type: 'boolean' }, quote: { type: 'number', minimum: 0 } }, required: ['withinBudget', 'quote'], additionalProperties: false },
        resources: { location: 'integration', adapterId: 'procurement-example' }, effect: 'pure', approval: { required: false },
        cancellation: 'immediate', confirmation: 'result', reconciliation: 'none', presentation: { label: 'Compare vendor quote' },
      },
      implementation: {
        async prepare(input) { return structuredClone(input); },
        async dispatch(_context, input) {
          dispatches.push({ operation: 'quote', input: structuredClone(input) });
          return { state: 'completed', output: { withinBudget: input.vendor.quote <= 5000, quote: input.vendor.quote } };
        },
      },
    },
  ];
  let runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Procurement composition must not allocate an agent provider.'); },
    runners: { execute: async () => assert.fail('Procurement composition must not allocate a runner.'), close: async () => {} },
    workflowActivities: [...registrations, ...extraActivities],
    ...(clock ? { clock } : {}),
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, fields = {}) => runtime.command({ action, client: 'procurement-composition-example', ...fields });
  const organization = await act('createOrganization', {
    slug: `procurement-example-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Procurement example', kind: 'team',
  });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Vendor review' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  return { act, project, dispatches, runtime, readState: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) };
}

async function documentFixture(t, workflowActivities) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-document-composition-example-'));
  let runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Registered extraction actions do not call a provider turn.'); },
    runners: { execute: async () => assert.fail('Document composition does not require a repository runner.'), close: async () => {} },
    workflowActivities,
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, fields = {}) => runtime.command({ action, client: 'document-composition-example', ...fields });
  const project = await act('saveProject', { name: 'Document intake' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  return { act, project, runtime, directory, readState: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) };
}

function childWorkflow({ id, name, projectId, activityId, outputSchema, resultSchema, resultBindings }) {
  return {
    id, name, projectId,
    runInputSchema: { type: 'object', properties: { vendor: { type: 'object', properties: {
      name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
    }, required: ['name', 'country', 'quote'], additionalProperties: false } }, required: ['vendor'], additionalProperties: false },
    resultSchema, resultBindings,
    nodes: [{ id: 'assess', name, kind: 'action', activity: { id: activityId, revision: 1 },
      bindings: { vendor: { from: { kind: 'run_input', path: ['vendor'] } } } }], edges: [],
  };
}

test('procurement runs two typed no-agent assessments and joins their declared results', async t => {
  const f = await fixture(t);
  const compliance = await f.act('saveWorkflow', { projectId: f.project.id, workflow: childWorkflow({
    id: 'vendor-compliance-review', name: 'Assess compliance', projectId: f.project.id,
    activityId: 'procurement.vendor-compliance',
    resultSchema: { type: 'object', properties: { eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 } }, required: ['eligible', 'basis'], additionalProperties: false },
    resultBindings: {
      eligible: { from: { kind: 'activity_output', nodeId: 'assess', path: ['eligible'] } },
      basis: { from: { kind: 'activity_output', nodeId: 'assess', path: ['basis'] } },
    },
  }) });
  const quote = await f.act('saveWorkflow', { projectId: f.project.id, workflow: childWorkflow({
    id: 'vendor-quote-comparison', name: 'Compare quote', projectId: f.project.id,
    activityId: 'procurement.quote-comparison',
    resultSchema: { type: 'object', properties: { withinBudget: { type: 'boolean' }, quote: { type: 'number', minimum: 0 } }, required: ['withinBudget', 'quote'], additionalProperties: false },
    resultBindings: {
      withinBudget: { from: { kind: 'activity_output', nodeId: 'assess', path: ['withinBudget'] } },
      quote: { from: { kind: 'activity_output', nodeId: 'assess', path: ['quote'] } },
    },
  }) });
  const vendorSchema = { type: 'object', properties: {
    name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
  }, required: ['name', 'country', 'quote'], additionalProperties: false };
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'vendor-procurement-review', name: 'Vendor procurement review', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { vendor: vendorSchema }, required: ['vendor'], additionalProperties: false },
    resultSchema: { type: 'object', properties: {
      compliance: { type: 'object', properties: { eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 } }, required: ['eligible', 'basis'], additionalProperties: false },
      quote: { type: 'object', properties: { withinBudget: { type: 'boolean' }, quote: { type: 'number', minimum: 0 } }, required: ['withinBudget', 'quote'], additionalProperties: false },
    }, required: ['compliance', 'quote'], additionalProperties: false },
    resultBindings: {
      compliance: { from: { kind: 'activity_output', nodeId: 'assessments', path: ['compliance'] } },
      quote: { from: { kind: 'activity_output', nodeId: 'assessments', path: ['quote'] } },
    },
    nodes: [{ id: 'assessments', name: 'Assess supplier', kind: 'parallel', join: 'all', maxConcurrent: 2, deadlineMs: 30_000,
      branches: [
        { id: 'compliance', workflow: { id: compliance.id, version: compliance.version },
          inputBindings: { vendor: { from: { kind: 'run_input', path: ['vendor'] } } },
          outputBindings: { eligible: { from: ['eligible'], to: ['compliance', 'eligible'] }, basis: { from: ['basis'], to: ['compliance', 'basis'] } } },
        { id: 'quote', workflow: { id: quote.id, version: quote.version },
          inputBindings: { vendor: { from: { kind: 'run_input', path: ['vendor'] } } },
          outputBindings: { withinBudget: { from: ['withinBudget'], to: ['quote', 'withinBudget'] }, quote: { from: ['quote'], to: ['quote', 'quote'] } } },
      ],
      outputSchema: { type: 'object', properties: {
        compliance: { type: 'object', properties: { eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 } }, required: ['eligible', 'basis'], additionalProperties: false },
        quote: { type: 'object', properties: { withinBudget: { type: 'boolean' }, quote: { type: 'number', minimum: 0 } }, required: ['withinBudget', 'quote'], additionalProperties: false },
      }, required: ['compliance', 'quote'], additionalProperties: false },
    }], edges: [],
  } });

  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { vendor: { name: 'Aster Components', country: 'BR', quote: 4750 } },
  });
  const startedAt = Date.now();
  let run;
  do {
    run = await f.act('getWorkflowRun', { workflowRunId });
    if (run.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() - startedAt < 5000);
  assert.equal(run.status, 'completed', JSON.stringify(run.compositions));
  assert.deepEqual((await f.readState()).workflowRuns[workflowRunId].result, {
    compliance: { eligible: true, basis: 'Country BR' },
    quote: { withinBudget: true, quote: 4750 },
  });
  assert.deepEqual(f.dispatches.map(value => value.operation).sort(), ['compliance', 'quote']);
  assert.equal((await f.runtime.snapshot()).sessions.length, 0, 'integration-only procurement assessments allocate no sessions');
});

test('document maps preserve input order and allocate an agent session only for the declared extraction route', async t => {
  const calls = { classify: [], basic: [], agent: [] };
  const documentSchema = { type: 'object', properties: {
    id: { type: 'string', maxLength: 80 }, text: { type: 'string', maxLength: 500 }, needsAgent: { type: 'boolean' },
  }, required: ['id', 'text', 'needsAgent'], additionalProperties: false };
  const extractedSchema = { type: 'object', properties: {
    documentId: { type: 'string', maxLength: 80 }, fields: { type: 'object', properties: { title: { type: 'string', maxLength: 120 } }, required: ['title'], additionalProperties: false },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  }, required: ['documentId', 'fields', 'confidence'], additionalProperties: false };
  const descriptor = (id, inputSchema, outputSchema, location = 'daemon') => ({
    ref: { id, revision: 1 }, inputSchema, outputSchema,
    resources: { location, ...(location === 'agent' ? { provider: 'required', workspace: false, tools: [] } : {}) },
    effect: 'pure', approval: { required: false }, cancellation: 'immediate', confirmation: 'result',
    reconciliation: 'none', presentation: { label: id },
  });
  const inputSchema = { type: 'object', properties: { document: documentSchema }, required: ['document'], additionalProperties: false };
  const registrations = [
    { descriptor: descriptor('documents.classify-route', inputSchema, { type: 'object', properties: { needsAgent: { type: 'boolean' } }, required: ['needsAgent'], additionalProperties: false }),
      implementation: {
        async prepare(input) { return { documentId: input.document.id }; },
        async dispatch(_context, input) {
          calls.classify.push(input.document.id);
          return { state: 'completed', output: { needsAgent: input.document.needsAgent } };
        },
      } },
    { descriptor: descriptor('documents.extract-basic', inputSchema, extractedSchema),
      implementation: {
        async prepare(input) { return { documentId: input.document.id }; },
        async dispatch(_context, input) {
          calls.basic.push(input.document.id);
          return { state: 'completed', output: { documentId: input.document.id, fields: { title: `Parsed ${input.document.id}` }, confidence: 0.75 } };
        },
      } },
    { descriptor: descriptor('documents.extract-with-agent', inputSchema, extractedSchema, 'agent'),
      implementation: {
        async prepare(input, _identity, context) {
          assert.ok(context.session?.currentAgentSessionId, 'agent route receives its own real provider session');
          return { documentId: input.document.id, providerSessionId: context.session.currentAgentSessionId };
        },
        async dispatch(context, input, intent) {
          assert.ok(context.session?.currentAgentSessionId, 'agent route retains its own provider session during dispatch');
          calls.agent.push({ id: input.document.id, sessionId: context.session.currentAgentSessionId, pinned: intent.providerSessionId });
          return { state: 'completed', output: { documentId: input.document.id, fields: { title: `Reviewed ${input.document.id}` }, confidence: 0.98 } };
        },
      } },
  ];
  const f = await documentFixture(t, registrations);
  const childInput = { type: 'object', properties: { doc: documentSchema, position: { type: 'integer', minimum: 0, maximum: 2 } }, required: ['doc', 'position'], additionalProperties: false };
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'document-extractor', name: 'Extract a document', projectId: f.project.id, runInputSchema: childInput,
    resultSchema: extractedSchema,
    resultBindingsByTerminal: {
      'basic-extract': {
        documentId: { from: { kind: 'activity_output', nodeId: 'basic-extract', path: ['documentId'] } },
        fields: { from: { kind: 'activity_output', nodeId: 'basic-extract', path: ['fields'] } },
        confidence: { from: { kind: 'activity_output', nodeId: 'basic-extract', path: ['confidence'] } },
      },
      'agent-extract': {
        documentId: { from: { kind: 'activity_output', nodeId: 'agent-extract', path: ['documentId'] } },
        fields: { from: { kind: 'activity_output', nodeId: 'agent-extract', path: ['fields'] } },
        confidence: { from: { kind: 'activity_output', nodeId: 'agent-extract', path: ['confidence'] } },
      },
    },
    nodes: [
      { id: 'classify', name: 'Select extraction path', kind: 'action', activity: { id: 'documents.classify-route', revision: 1 },
        bindings: { document: { from: { kind: 'run_input', path: ['doc'] } } } },
      { id: 'route', name: 'Use optional review route', kind: 'branch', condition: {
        source: 'actionResult', field: 'needsAgent', equals: true, trueOutcome: 'review', falseOutcome: 'parse',
      } },
      { id: 'basic-extract', name: 'Parse document fields', kind: 'action', activity: { id: 'documents.extract-basic', revision: 1 },
        bindings: { document: { from: { kind: 'run_input', path: ['doc'] } } } },
      { id: 'agent-extract', name: 'Review document fields', kind: 'action', model: 'fixture', activity: { id: 'documents.extract-with-agent', revision: 1 },
        permissions: 'none', bindings: { document: { from: { kind: 'run_input', path: ['doc'] } } } },
    ],
    entryNode: 'classify', edges: [
      { from: 'classify', to: 'route', outcome: 'success' },
      { from: 'route', to: 'agent-extract', outcome: 'review' },
      { from: 'route', to: 'basic-extract', outcome: 'parse' },
    ],
  } });
  const itemSchema = { type: 'object', properties: { documentId: { type: 'string', maxLength: 80 }, fields: extractedSchema.properties.fields, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['documentId', 'fields', 'confidence'], additionalProperties: false };
  const parent = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'document-intake-map', name: 'Map bounded document intake', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { documents: { type: 'array', items: documentSchema, minItems: 1, maxItems: 2 } }, required: ['documents'], additionalProperties: false },
    nodes: [{ id: 'extract-documents', name: 'Extract configured documents', kind: 'map',
      itemsBinding: { from: { kind: 'run_input', path: ['documents'] } }, itemField: 'doc', indexField: 'position',
      workflow: { id: child.id, version: child.version }, inputBindings: {}, outputSchema: { type: 'array', items: itemSchema },
      outputBindings: {
        documentId: { from: ['documentId'] }, fields: { from: ['fields'] }, confidence: { from: ['confidence'] },
      }, maxItems: 2, maxConcurrent: 2, deadlineMs: 60_000, failurePolicy: 'fail_fast',
    }], edges: [],
  } });
  const input = { documents: [
    { id: 'invoice-a', text: 'Invoice A', needsAgent: false },
    { id: 'contract-b', text: 'Contract B', needsAgent: true },
  ] };
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: parent.id, workflowVersion: parent.version, runInput: input });
  const deadline = Date.now() + 7000;
  let run;
  do {
    run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    if (run.status === 'completed' || run.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(run.status, 'completed', JSON.stringify(run.compositions));
  assert.deepEqual(calls.classify.sort(), ['contract-b', 'invoice-a']);
  assert.deepEqual(calls.basic, ['invoice-a']);
  assert.deepEqual(calls.agent.map(value => value.id), ['contract-b']);
  assert.equal(calls.agent[0].pinned, calls.agent[0].sessionId);
  const snapshot = await f.runtime.snapshot();
  assert.equal(snapshot.sessions.filter(value => value.workflowRunId || value.flow?.workflowId === child.id).length, 1,
    'only the document that takes the optional agent route allocates a session');
  const state = await f.readState();
  assert.deepEqual(state.workflowRuns[started.workflowRunId].activityOutputs['extract-documents'].value.map(value => value.documentId), ['invoice-a', 'contract-b']);
  assert.deepEqual(state.workflowRuns[started.workflowRunId].activityOutputs['extract-documents'].value.map(value => value.confidence), [0.75, 0.98]);
  await assert.rejects(f.act('startWorkflowRun', { projectId: f.project.id, workflowId: parent.id, workflowVersion: parent.version,
    runInput: { documents: [input.documents[0], input.documents[0], input.documents[0]] } }), /array length/i);
  assert.deepEqual(calls.classify.sort(), ['contract-b', 'invoice-a'], 'oversized maps reject before any child activity dispatch');
});

test('literal maps validate each heterogeneous JSON item and preserve declared fields with spaces', async t => {
  const f = await fixture(t);
  const vendorSchema = { type: 'object', properties: {
    name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
  }, required: ['name', 'country', 'quote'], additionalProperties: false };
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'literal-vendor-assessment', name: 'Assess literal vendor', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { 'vendor record': vendorSchema }, required: ['vendor record'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { quote: { type: 'number', minimum: 0 } }, required: ['quote'], additionalProperties: false },
    resultBindings: { quote: { from: { kind: 'activity_output', nodeId: 'assess', path: ['quote'] } } },
    nodes: [{ id: 'assess', name: 'Compare quote', kind: 'action', activity: { id: 'procurement.quote-comparison', revision: 1 },
      bindings: { vendor: { from: { kind: 'run_input', path: ['vendor record'] } } } }], edges: [],
  } });
  const parent = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'literal-vendor-map', name: 'Map literal vendors', projectId: f.project.id,
    nodes: [{ id: 'assess-vendors', name: 'Assess configured vendors', kind: 'map',
      itemsBinding: { literal: [
        { name: 'A', country: 'BR', quote: 125 },
        { name: 'A supplier with a longer name', country: 'PT', quote: 210 },
      ] }, itemField: 'vendor record', workflow: { id: child.id, version: child.version }, inputBindings: {},
      outputSchema: { type: 'array', items: { type: 'object', properties: { quote: { type: 'number', minimum: 0 } }, required: ['quote'], additionalProperties: false } },
      outputBindings: { quote: { from: ['quote'] } }, maxItems: 2, maxConcurrent: 2, deadlineMs: 30_000, failurePolicy: 'fail_fast',
    }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: parent.id, workflowVersion: parent.version });
  const deadline = Date.now() + 7000;
  let completed;
  do {
    completed = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    if (['completed', 'failed'].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.compositions));
  assert.deepEqual(f.dispatches.filter(item => item.operation === 'quote').map(item => item.input.vendor.quote), [125, 210]);

  const invalid = structuredClone(parent);
  invalid.id = 'literal-vendor-map-invalid'; invalid.name = 'Reject invalid literal vendor';
  invalid.nodes[0].itemsBinding.literal[1].quote = -1;
  await assert.rejects(f.act('saveWorkflow', { projectId: f.project.id, workflow: invalid }), /minimum|quote/i,
    'each item is checked against the pinned child field schema before publication');
});

test('sequential maps reserve against one cumulative root item budget before creating later children', async t => {
  const calls = [];
  const valueSchema = { type: 'integer', minimum: 0, maximum: 200 };
  const inputSchema = { type: 'object', properties: { item: valueSchema }, required: ['item'], additionalProperties: false };
  const outputSchema = { type: 'object', properties: { value: valueSchema }, required: ['value'], additionalProperties: false };
  const activity = {
    descriptor: { ref: { id: 'records.item-count', revision: 1 }, inputSchema, outputSchema,
      resources: { location: 'integration', adapterId: 'map-budget-example' }, effect: 'pure', approval: { required: false },
      cancellation: 'immediate', confirmation: 'result', reconciliation: 'none', presentation: { label: 'Count one record' } },
    implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) { calls.push(input.item); return { state: 'completed', output: { value: input.item } }; },
    },
  };
  const f = await fixture(t, { extraActivities: [activity] });
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'map-budget-child', name: 'Process one record', projectId: f.project.id,
    runInputSchema: inputSchema, resultSchema: outputSchema,
    resultBindings: { value: { from: { kind: 'activity_output', nodeId: 'copy', path: ['value'] } } },
    nodes: [{ id: 'copy', name: 'Count one record', kind: 'action', activity: activity.descriptor.ref,
      bindings: { item: { from: { kind: 'run_input', path: ['item'] } } } }], edges: [],
  } });
  const listSchema = maxItems => ({ type: 'array', items: valueSchema, minItems: 1, maxItems });
  const mappedOutput = { type: 'array', items: outputSchema, minItems: 1, maxItems: 60 };
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'cumulative-map-budget', name: 'Process two bounded record groups', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { first: listSchema(51), second: listSchema(50) }, required: ['first', 'second'], additionalProperties: false },
    nodes: [
      { id: 'first-group', name: 'Process first group', kind: 'map', workflow: { id: child.id, version: child.version },
        itemsBinding: { from: { kind: 'run_input', path: ['first'] } }, itemField: 'item', inputBindings: {},
        outputSchema: mappedOutput, outputBindings: { value: { from: ['value'] } }, maxItems: 51, maxConcurrent: 8,
        deadlineMs: 60_000, failurePolicy: 'fail_fast' },
      { id: 'second-group', name: 'Process second group', kind: 'map', workflow: { id: child.id, version: child.version },
        itemsBinding: { from: { kind: 'run_input', path: ['second'] } }, itemField: 'item', inputBindings: {},
        outputSchema: mappedOutput, outputBindings: { value: { from: ['value'] } }, maxItems: 50, maxConcurrent: 8,
        deadlineMs: 60_000, failurePolicy: 'fail_fast' },
    ],
    edges: [{ from: 'first-group', to: 'second-group', outcome: 'success' }],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { first: Array.from({ length: 51 }, (_, index) => index), second: Array.from({ length: 50 }, (_, index) => index + 51) } });
  const until = Date.now() + 9000;
  let run;
  do {
    run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    if (['completed', 'failed'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.equal(run.status, 'failed', JSON.stringify(run.compositions));
  assert.deepEqual([...calls].sort((left, right) => left - right), Array.from({ length: 51 }, (_, index) => index),
    'the later map fails its cumulative root budget before any second-group effect');
  const state = await f.readState();
  const parent = state.workflowRuns[started.workflowRunId];
  const firstAttempt = parent.compositionAttempts.find(value => value.nodeId === 'first-group');
  assert.equal(firstAttempt.slots.length, 51);
  assert.ok(firstAttempt.slots.every(slot => state.workflowRuns[slot.runId]), 'all first-group children retain their exact canonical runs');
  assert.equal(parent.compositionAttempts.some(value => value.nodeId === 'second-group'), false,
    'an over-budget map does not persist a permanently undispatchable reservation');
  assert.equal(Object.values(state.workflowRuns).filter(value => value.parentComposition?.parentRunId === parent.id).length, 51,
    'no second-group child run is admitted after the cumulative ceiling is reached');
});

test('collect-errors maps retain both successful typed values and bounded failure records', async t => {
  const f = await fixture(t);
  const vendorSchema = { type: 'object', properties: {
    name: { type: 'string', maxLength: 80 }, country: { type: 'string', maxLength: 2 }, quote: { type: 'number', minimum: 0 },
  }, required: ['name', 'country', 'quote'], additionalProperties: false };
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'collect-vendor-check', name: 'Check one vendor', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { vendor: vendorSchema }, required: ['vendor'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 } }, required: ['eligible', 'basis'], additionalProperties: false },
    resultBindings: {
      eligible: { from: { kind: 'activity_output', nodeId: 'assess', path: ['eligible'] } },
      basis: { from: { kind: 'activity_output', nodeId: 'assess', path: ['basis'] } },
    },
    nodes: [{ id: 'assess', name: 'Assess vendor', kind: 'action', activity: { id: 'procurement.vendor-compliance', revision: 1 },
      bindings: { vendor: { from: { kind: 'run_input', path: ['vendor'] } } } }], edges: [],
  } });
  const parent = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'collect-vendor-map', name: 'Collect vendor checks', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { vendors: { type: 'array', items: vendorSchema, minItems: 1, maxItems: 3 } }, required: ['vendors'], additionalProperties: false },
    nodes: [{ id: 'checks', name: 'Check all vendors', kind: 'map', itemsBinding: { from: { kind: 'run_input', path: ['vendors'] } },
      itemField: 'vendor', workflow: { id: child.id, version: child.version }, inputBindings: {},
      outputSchema: { type: 'array', items: { type: 'object', properties: {
        eligible: { type: 'boolean' }, basis: { type: 'string', maxLength: 100 }, index: { type: 'integer', minimum: 0, maximum: 2 },
        status: { type: 'string', enum: ['failed', 'cancelled'] }, message: { type: 'string', maxLength: 500 },
      }, required: [], additionalProperties: false } },
      outputBindings: { eligible: { from: ['eligible'] }, basis: { from: ['basis'] } },
      maxItems: 3, maxConcurrent: 2, deadlineMs: 30_000, failurePolicy: 'collect_errors',
    }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: parent.id, workflowVersion: parent.version,
    runInput: { vendors: [
      { name: 'Northwind', country: 'BR', quote: 200 }, { name: 'Contoso', country: 'XX', quote: 300 },
    ] } });
  const deadline = Date.now() + 7000;
  let run;
  do {
    run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    if (run.status === 'completed' || run.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(run.status, 'completed', JSON.stringify(run.compositions));
  const output = (await f.readState()).workflowRuns[started.workflowRunId].activityOutputs.checks.value;
  assert.equal(output.length, 2);
  assert.deepEqual(output[0], { eligible: true, basis: 'Country BR' });
  assert.deepEqual(output[1], { index: 1, status: 'failed', message: 'Vendor record could not be assessed.' });
});

test('a configured human response maps to a typed terminal result even when its outcome resembles a legacy repair route', async t => {
  const f = await documentFixture(t, []);
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'quoted-amount-capture', name: 'Capture reviewed amount', projectId: f.project.id, maxRevisions: 0,
    resultSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 0, maximum: 100_000 } }, required: ['amount'], additionalProperties: false },
    resultBindingsByTerminal: { 'review-amount': { amount: { from: { kind: 'human_response', nodeId: 'review-amount', path: ['approvedAmount'] } } } },
    nodes: [{ id: 'review-amount', name: 'Review amount', kind: 'human', humanTask: {
      outcomes: [{ id: 'changes_requested', label: 'Record revised amount' }, { id: 'declined', label: 'Decline' }],
      form: { fields: [{ id: 'approvedAmount', label: 'Approved amount', type: 'number', required: true, minimum: 0, maximum: 100_000 }] },
    } }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version });
  await f.act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  const waiting = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  const response = await f.act('submitWorkflowHumanResponse', { workflowRunId: started.workflowRunId, instance: waiting.instance,
    values: { approvedAmount: 72.5 } });
  const review = await f.act('prepareWorkflowHumanReview', { workflowRunId: started.workflowRunId, instance: waiting.instance,
    responseId: response.id, outcomeId: 'changes_requested' });
  await f.act('decideWorkflowRun', { workflowRunId: started.workflowRunId, instance: waiting.instance,
    outcomeId: 'changes_requested', responseId: response.id, reviewedMaterialDigest: review.materialDigest });
  const saved = (await f.readState()).workflowRuns[started.workflowRunId];
  assert.equal(saved.flow.status, 'completed', 'configured outcome IDs do not receive legacy repair-loop semantics');
  assert.deepEqual(saved.result, { amount: 72.5 });
  assert.equal(saved.resultDigest, activityDigest({ amount: 72.5 }));
});

test('first-success deadlines keep a predeadline winner while draining losers and reject late winners', async t => {
  let currentTime = Date.now();
  const resolution = new Map();
  const activity = {
    ref: { id: 'procurement.deadline-probe', revision: 1 },
    inputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resources: { location: 'integration', adapterId: 'deadline-example' }, effect: 'durable-effect', approval: { required: false },
    cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Confirm deadline probe' },
  };
  const f = await fixture(t, { clock: () => currentTime, extraActivities: [{ descriptor: activity, implementation: {
    async prepare(input) { return { label: input.label }; },
    async dispatch(_context, _input, intent) {
      if (intent.label === 'fast') return { state: 'completed', output: { label: intent.label } };
      if (intent.label === 'failed') return { state: 'failed', message: 'The late operation was not applied.' };
      throw new Error('The operation may have been applied before acknowledgement was lost.');
    },
    async confirm() { return { state: 'waiting' }; },
    async reconcile(_context, _input, intent) {
      if (!resolution.has(intent.label)) return { state: 'unknown' };
      if (!resolution.get(intent.label)) return { state: 'not_applied' };
      return { state: 'applied', output: { label: intent.label } };
    },
  } }] });
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'deadline-probe-child', name: 'Run one deadline probe', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resultBindings: { label: { from: { kind: 'activity_output', nodeId: 'probe', path: ['label'] } } },
    nodes: [{ id: 'probe', name: 'Probe', kind: 'action', activity: activity.ref,
      bindings: { label: { from: { kind: 'run_input', path: ['label'] } } } }], edges: [],
  } });
  const makeParent = async (id, labels) => f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id, name: id, projectId: f.project.id,
    resultSchema: { type: 'object', properties: { winner: { type: 'string', maxLength: 40 } }, required: ['winner'], additionalProperties: false },
    resultBindings: { winner: { from: { kind: 'activity_output', nodeId: 'fork', path: ['winner'] } } },
    nodes: [{ id: 'fork', name: 'Choose first success', kind: 'parallel', join: 'first_success', maxConcurrent: 2, deadlineMs: 10_000,
      branches: labels.map(label => ({ id: label, workflow: { id: child.id, version: child.version },
        inputBindings: { label: { literal: label } }, outputBindings: { label: { from: ['label'], to: ['winner'] } } })),
      outputSchema: { type: 'object', properties: { winner: { type: 'string', maxLength: 40 } }, required: ['winner'], additionalProperties: false } }], edges: [],
  } });
  const readUntil = async (runId, predicate, message) => {
    const deadline = Date.now() + 8000;
    let value;
    do {
      value = await f.act('getWorkflowRun', { workflowRunId: runId });
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  };
  const reconcileChild = async (parent, slotId, applied) => {
    const slot = parent.compositions[0].slots.find(value => value.slotId === slotId);
    const run = await f.act('getWorkflowRun', { workflowRunId: slot.runId });
    await f.act('claimWorkflowRun', { workflowRunId: run.id });
    resolution.set(slotId, applied);
    await f.act('reconcileWorkflowRun', { workflowRunId: run.id, instance: run.instance,
      effectKey: run.attempt.effectKey, resolution: applied ? 'applied' : 'not_applied' });
  };

  const beforeDeadline = await makeParent('deadline-winner-before', ['fast', 'loser']);
  const first = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: beforeDeadline.id, workflowVersion: beforeDeadline.version });
  const firstWaiting = await readUntil(first.workflowRunId, run => run.compositions?.[0]?.winnerSlotId === 'fast' &&
    run.compositions[0].slots.some(slot => slot.slotId === 'loser' && slot.status === 'uncertain'), 'predeadline winner did not settle');
  currentTime += 20_000;
  await reconcileChild(firstWaiting, 'loser', true);
  const firstDone = await readUntil(first.workflowRunId, run => ['completed', 'failed'].includes(run.status), 'winner did not settle after loser cleanup');
  assert.equal(firstDone.status, 'completed', 'an already recorded winner completed before deadline remains valid while a loser is reconciled');
  assert.equal((await f.readState()).workflowRuns[first.workflowRunId].result.winner, 'fast');

  const lateWorkflow = await makeParent('deadline-no-late-winner', ['late', 'failed']);
  const second = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: lateWorkflow.id, workflowVersion: lateWorkflow.version });
  const lateWaiting = await readUntil(second.workflowRunId, run => run.compositions?.[0]?.slots.some(slot => slot.slotId === 'late' && slot.status === 'uncertain') &&
    run.compositions[0].slots.some(slot => slot.slotId === 'failed' && slot.status === 'failed'), 'late candidates did not settle');
  currentTime += 20_000;
  await reconcileChild(lateWaiting, 'late', true);
  const secondDone = await readUntil(second.workflowRunId, run => ['completed', 'failed'].includes(run.status), 'expired join did not settle');
  assert.equal(secondDone.status, 'failed', 'a receipt completed after deadline cannot create a new first-success winner');
});

test('a child that completes after the injected deadline cannot create a first-success winner', async t => {
  let currentTime = Date.now();
  let releaseLate;
  let signalLateEntered;
  let enteredTimer;
  const lateDispatch = new Promise(resolve => { releaseLate = resolve; });
  const entered = new Promise(resolve => { signalLateEntered = resolve; });
  const activity = {
    ref: { id: 'procurement.deadline-completion', revision: 1 },
    inputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resources: { location: 'integration', adapterId: 'deadline-completion-example' }, effect: 'pure', approval: { required: false },
    cancellation: 'immediate', confirmation: 'result', reconciliation: 'none', presentation: { label: 'Complete deadline probe' },
  };
  const f = await fixture(t, { clock: () => currentTime, extraActivities: [{ descriptor: activity, implementation: {
    async prepare(input) { return { label: input.label }; },
    async dispatch(_context, _input, intent) {
      if (intent.label === 'late') {
        signalLateEntered();
        await lateDispatch;
      }
      return { state: intent.label === 'failed' ? 'failed' : 'completed', ...(intent.label === 'failed' ? { message: 'No effect.' } : { output: { label: intent.label } }) };
    },
  } }] });
  t.after(() => { releaseLate(); clearTimeout(enteredTimer); });
  const child = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'deadline-completion-child', name: 'Complete one probe', projectId: f.project.id,
    runInputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'], additionalProperties: false },
    resultBindings: { label: { from: { kind: 'activity_output', nodeId: 'probe', path: ['label'] } } },
    nodes: [{ id: 'probe', name: 'Probe', kind: 'action', activity: activity.ref,
      bindings: { label: { from: { kind: 'run_input', path: ['label'] } } } }], edges: [],
  } });
  const parent = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'deadline-completion-parent', name: 'Reject a late completion', projectId: f.project.id,
    resultSchema: { type: 'object', properties: { winner: { type: 'string', maxLength: 40 } }, required: ['winner'], additionalProperties: false },
    resultBindings: { winner: { from: { kind: 'activity_output', nodeId: 'fork', path: ['winner'] } } },
    nodes: [{ id: 'fork', name: 'Choose first success', kind: 'parallel', join: 'first_success', maxConcurrent: 2, deadlineMs: 10_000,
      branches: ['late', 'failed'].map(label => ({ id: label, workflow: { id: child.id, version: child.version },
        inputBindings: { label: { literal: label } }, outputBindings: { label: { from: ['label'], to: ['winner'] } } })),
      outputSchema: { type: 'object', properties: { winner: { type: 'string', maxLength: 40 } }, required: ['winner'], additionalProperties: false } }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: parent.id, workflowVersion: parent.version });
  try {
    await Promise.race([entered, new Promise((_, reject) => {
      enteredTimer = setTimeout(() => reject(new Error('late child did not reach dispatch')), 5000);
      enteredTimer.unref?.();
    })]);
    currentTime += 20_000;
    releaseLate();
    const until = Date.now() + 7000;
    let run;
    do {
      run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
      if (['completed', 'failed'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < until);
    assert.equal(run.status, 'failed', 'a completion observed after the shared injected deadline cannot create a winner');
    assert.equal(run.compositions[0].winnerSlotId, undefined);
    const parentState = (await f.readState()).workflowRuns[started.workflowRunId];
    assert.equal(parentState.result, undefined);
    const lateSlot = run.compositions[0].slots.find(slot => slot.slotId === 'late');
    const lateChild = (await f.readState()).workflowRuns[lateSlot.runId];
    assert.equal(lateChild.flow.status, 'completed', 'the candidate completed rather than being cancelled while still running');
    assert.ok(Date.parse(lateChild.flow.history.at(-1).at) > Date.parse(run.compositions[0].deadlineAt), 'the recorded child completion is after the parent deadline');
  } finally {
    releaseLate();
    clearTimeout(enteredTimer);
  }
});
