import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function fixture(t) {
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
    workflowActivities: registrations,
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
