import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const emptyObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const stringList = (maxItems = 32) => ({ type: 'array', items: { type: 'string', maxLength: 120 }, maxItems });
const number = (minimum = 0, maximum = 1_000_000) => ({ type: 'number', minimum, maximum });
const integer = (minimum = 0, maximum = 1_000_000) => ({ type: 'integer', minimum, maximum });

function descriptor(id, revision, inputSchema, outputSchema, { effect = 'pure', approval = { required: false } } = {}) {
  const durable = effect === 'durable-effect';
  return {
    ref: { id, revision }, inputSchema, outputSchema,
    resources: { location: 'integration', adapterId: 'acceptance-fake' },
    effect, approval,
    cancellation: durable ? 'reconcile-after-dispatch' : 'immediate',
    confirmation: durable ? 'adapter-confirmed' : 'result',
    reconciliation: durable ? 'adapter' : 'none',
    presentation: { label: id },
  };
}

function activityNode(id, name, ref, bindings) {
  return { id, name, kind: 'action', activity: { id: ref, revision: 1 }, bindings };
}

async function waitForRun(act, workflowRunId, predicate, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await act('getWorkflowRun', { workflowRunId });
    if (predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message ?? `Workflow run ${workflowRunId} did not reach the expected state.`);
}

async function fixture(t, { workflowActivities = [], omitActivitiesOnRestart = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-registered-activities-'));
  const baseOptions = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('No-resource activity flows must not invoke a model provider.'); },
    runners: {
      execute: async () => { assert.fail('No-resource activity flows must not acquire a runner.'); },
      close: async () => {},
    },
    workflowActivities,
  };
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime(baseOptions);
  const act = async (action, input = {}) => {
    try {
      return await runtime.command({ action, client: 'registered-activity-acceptance', ...input });
    } catch (error) {
      error.message = `${action}${input.workflow?.id ? ` ${input.workflow.id}` : ''}: ${error.message}`;
      throw error;
    }
  };
  const organizations = {};
  const projects = {};
  for (const [key, displayName] of [['procurement', 'Procurement'], ['documents', 'Document processing']]) {
    organizations[key] = await act('createOrganization', {
      slug: `activity-${key}`, displayName, kind: 'team',
    });
    projects[key] = await act('saveProject', {
      organizationId: organizations[key].id,
      name: key === 'procurement' ? 'Vendor assessment' : 'Records intake',
    });
    await act('selectActiveContext', {
      context: { organizationId: organizations[key].id, projectId: projects[key].id },
    });
  }
  return {
    directory, act, projects, organizations,
    snapshot: (...args) => runtime.snapshot(undefined, 'registered-activity-acceptance', ...args),
    async restart({ omitActivities = omitActivitiesOnRestart } = {}) {
      await runtime.close();
      runtime = await createRuntime({ ...baseOptions, workflowActivities: omitActivities ? [] : workflowActivities });
    },
    async persisted() {
      await runtime.close();
      runtime = null;
      return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    },
    async readPersisted() { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); },
  };
}

function genericRegistrations({ downstreamInputs, dispatchLog }) {
  const valueSchemas = Object.fromEntries(Object.entries(downstreamInputs).map(([id, schema]) => [id, schema]));
  const registrations = [];
  for (const [id, inputSchema, outputSchema, produce] of Object.values(valueSchemas)) {
    const activityDescriptor = descriptor(id, 1, inputSchema, outputSchema);
    registrations.push({
      descriptor: activityDescriptor,
      implementation: {
        async prepare(input) { return { preparedInput: structuredClone(input) }; },
        async dispatch(context, input) {
          dispatchLog.push({ id, runId: context.run.id, nodeId: context.node.id });
          return { state: 'completed', output: produce(input) };
        },
      },
    });
  }
  return registrations;
}

test('registered activities run two unrelated typed no-session workflows and preserve derived results', async t => {
  const dispatchLog = [];
  const procurementInput = {
    type: 'object', properties: { requestedAmount: number(0, 50_000), vendorActive: { type: 'boolean' }, suppliers: stringList(12) },
    required: ['requestedAmount', 'vendorActive', 'suppliers'], additionalProperties: false,
  };
  const procurementOutput = {
    type: 'object', properties: { quoteAmount: number(0, 50_000), eligible: { type: 'boolean' }, supplierNames: stringList(12) },
    required: ['quoteAmount', 'eligible', 'supplierNames'], additionalProperties: false,
  };
  const procurementArchiveInput = {
    type: 'object', properties: { amount: number(0, 50_000), accepted: { type: 'boolean' }, vendors: stringList(12) },
    required: ['amount', 'accepted', 'vendors'], additionalProperties: false,
  };
  const documentInput = {
    type: 'object', properties: { pages: integer(1, 1000), ocrScore: number(0, 1), headings: stringList(32) },
    required: ['pages', 'ocrScore', 'headings'], additionalProperties: false,
  };
  const documentOutput = {
    type: 'object', properties: { pageCount: integer(1, 1000), searchable: { type: 'boolean' }, sections: stringList(32) },
    required: ['pageCount', 'searchable', 'sections'], additionalProperties: false,
  };
  const indexInput = {
    type: 'object', properties: { pageTotal: integer(1, 1000), searchable: { type: 'boolean' }, headings: stringList(32) },
    required: ['pageTotal', 'searchable', 'headings'], additionalProperties: false,
  };
  const registrations = [
    ...genericRegistrations({ dispatchLog, downstreamInputs: {
      'procurement.evaluate': [
        'procurement.evaluate',
        { type: 'object', properties: { requestedAmount: number(0, 50_000), vendorActive: { type: 'boolean' }, suppliers: stringList(12) }, required: ['requestedAmount', 'vendorActive', 'suppliers'], additionalProperties: false },
        procurementOutput,
        input => ({ quoteAmount: input.requestedAmount, eligible: input.vendorActive, supplierNames: input.suppliers }),
      ],
      'procurement.archive': [
        'procurement.archive', procurementArchiveInput,
        { type: 'object', properties: { amount: number(0, 50_000), accepted: { type: 'boolean' }, vendors: stringList(12) }, required: ['amount', 'accepted', 'vendors'], additionalProperties: false },
        input => ({ amount: input.amount, accepted: input.accepted, vendors: input.vendors }),
      ],
      'documents.extract': [
        'documents.extract', documentInput, documentOutput,
        input => ({ pageCount: input.pages, searchable: input.ocrScore >= 0.8, sections: input.headings }),
      ],
      'documents.index': [
        'documents.index', indexInput,
        { type: 'object', properties: { pageTotal: integer(1, 1000), searchable: { type: 'boolean' }, headings: stringList(32) }, required: ['pageTotal', 'searchable', 'headings'], additionalProperties: false },
        input => ({ pageTotal: input.pageTotal, searchable: input.searchable, headings: input.headings }),
      ],
    } }),
  ];
  const f = await fixture(t, { workflowActivities: registrations });

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: {
    id: 'vendor-assessment', name: 'Vendor assessment',
    runInputSchema: procurementInput,
    resultSchema: { type: 'object', properties: { amount: number(0, 50_000), eligible: { type: 'boolean' }, suppliers: stringList(12) }, required: ['amount', 'eligible', 'suppliers'], additionalProperties: false },
    resultBindings: {
      amount: { from: { kind: 'activity_output', nodeId: 'archive', path: ['amount'] } },
      eligible: { from: { kind: 'activity_output', nodeId: 'archive', path: ['accepted'] } },
      suppliers: { from: { kind: 'activity_output', nodeId: 'archive', path: ['vendors'] } },
    },
    nodes: [
      activityNode('assess', 'Assess vendor', 'procurement.evaluate', {
        requestedAmount: { from: { kind: 'run_input', path: ['requestedAmount'] } },
        vendorActive: { from: { kind: 'run_input', path: ['vendorActive'] } },
        suppliers: { from: { kind: 'run_input', path: ['suppliers'] } },
      }),
      activityNode('archive', 'Archive assessment', 'procurement.archive', {
        amount: { from: { kind: 'activity_output', nodeId: 'assess', path: ['quoteAmount'] } },
        accepted: { from: { kind: 'activity_output', nodeId: 'assess', path: ['eligible'] } },
        vendors: { from: { kind: 'activity_output', nodeId: 'assess', path: ['supplierNames'] } },
      }),
    ],
    edges: [{ from: 'assess', to: 'archive', outcome: 'success' }],
  } });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.documents.id, projectId: f.projects.documents.id } });
  await f.act('saveWorkflow', { projectId: f.projects.documents.id, workflow: {
    id: 'document-intake', name: 'Document intake',
    runInputSchema: documentInput,
    resultSchema: { type: 'object', properties: { pages: integer(1, 1000), searchable: { type: 'boolean' }, headings: stringList(32) }, required: ['pages', 'searchable', 'headings'], additionalProperties: false },
    resultBindings: {
      pages: { from: { kind: 'activity_output', nodeId: 'index', path: ['pageTotal'] } },
      searchable: { from: { kind: 'activity_output', nodeId: 'index', path: ['searchable'] } },
      headings: { from: { kind: 'activity_output', nodeId: 'index', path: ['headings'] } },
    },
    nodes: [
      activityNode('extract', 'Extract document facts', 'documents.extract', {
        pages: { from: { kind: 'run_input', path: ['pages'] } },
        ocrScore: { from: { kind: 'run_input', path: ['ocrScore'] } },
        headings: { from: { kind: 'run_input', path: ['headings'] } },
      }),
      activityNode('index', 'Index document facts', 'documents.index', {
        pageTotal: { from: { kind: 'activity_output', nodeId: 'extract', path: ['pageCount'] } },
        searchable: { from: { kind: 'activity_output', nodeId: 'extract', path: ['searchable'] } },
        headings: { from: { kind: 'activity_output', nodeId: 'extract', path: ['sections'] } },
      }),
    ],
    edges: [{ from: 'extract', to: 'index', outcome: 'success' }],
  } });

  const procurementRun = await f.act('startWorkflowRun', {
    projectId: f.projects.procurement.id, workflowId: 'vendor-assessment', workflowVersion: 1,
    runInput: { requestedAmount: 2400, vendorActive: true, suppliers: ['Northwind', 'Contoso'] },
  });
  const documentRun = await f.act('startWorkflowRun', {
    projectId: f.projects.documents.id, workflowId: 'document-intake', workflowVersion: 1,
    runInput: { pages: 18, ocrScore: 0.94, headings: ['Scope', 'Controls', 'Appendix'] },
  });
  const procurement = await waitForRun(f.act, procurementRun.workflowRunId, run => run.status === 'completed' || run.status === 'failed');
  const documents = await waitForRun(f.act, documentRun.workflowRunId, run => run.status === 'completed' || run.status === 'failed');
  assert.equal(procurement.status, 'completed');
  assert.equal(documents.status, 'completed');
  assert.deepEqual(dispatchLog.map(value => value.id).sort(), [
    'documents.extract', 'documents.index', 'procurement.archive', 'procurement.evaluate',
  ]);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.workflowActivities.some(value => value.ref.id === 'documents.extract' && value.available), true);
  const beforeRestart = await f.readPersisted();
  const savedProcurement = beforeRestart.workflowRuns[procurementRun.workflowRunId];
  const savedDocuments = beforeRestart.workflowRuns[documentRun.workflowRunId];
  assert.equal(savedProcurement.projectId, f.projects.procurement.id);
  assert.equal(savedProcurement.organizationId, f.organizations.procurement.id);
  assert.equal(savedDocuments.projectId, f.projects.documents.id);
  assert.equal(savedDocuments.organizationId, f.organizations.documents.id);
  assert.deepEqual(savedProcurement.result, { amount: 2400, eligible: true, suppliers: ['Northwind', 'Contoso'] });
  assert.deepEqual(savedDocuments.result, { pages: 18, searchable: true, headings: ['Scope', 'Controls', 'Appendix'] });
  assert.match(savedProcurement.resultDigest, /^[a-f0-9]{64}$/);
  assert.match(savedDocuments.resultDigest, /^[a-f0-9]{64}$/);
  await f.restart();
  const afterRestart = await f.persisted();
  assert.deepEqual(afterRestart.workflowRuns[procurementRun.workflowRunId].result, savedProcurement.result);
  assert.deepEqual(afterRestart.workflowRuns[documentRun.workflowRunId].result, savedDocuments.result);
  assert.equal(afterRestart.workflowRuns[procurementRun.workflowRunId].resultDigest, savedProcurement.resultDigest);
  assert.equal(afterRestart.workflowRuns[documentRun.workflowRunId].resultDigest, savedDocuments.resultDigest);
});

test('incompatible bindings reject before dispatch; missing activity revisions remain visible and fail closed', async t => {
  const dispatchLog = [];
  const inputSchema = { type: 'object', properties: { value: number() }, required: ['value'], additionalProperties: false };
  const outputSchema = { type: 'object', properties: { value: number() }, required: ['value'], additionalProperties: false };
  const registration = {
    descriptor: descriptor('documents.convert', 1, inputSchema, outputSchema),
    implementation: {
      async prepare(input) { return { preparedInput: input }; },
      async dispatch(context, input) {
        dispatchLog.push(context.node.id);
        return { state: 'completed', output: { value: input.value } };
      },
    },
  };
  const textDescriptor = descriptor('documents.expect-label', 1,
    { type: 'object', properties: { value: { type: 'string', maxLength: 80 } }, required: ['value'], additionalProperties: false },
    { type: 'object', properties: { value: { type: 'string', maxLength: 80 } }, required: ['value'], additionalProperties: false });
  const textRegistration = {
    descriptor: textDescriptor,
    implementation: {
      async prepare(input) { return { preparedInput: input }; },
      async dispatch(_context, input) { return { state: 'completed', output: input }; },
    },
  };
  const f = await fixture(t, { workflowActivities: [registration, textRegistration] });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.documents.id, projectId: f.projects.documents.id } });
  await f.act('saveWorkflow', { projectId: f.projects.documents.id, workflow: {
    id: 'pinned-document-conversion', name: 'Pinned document conversion',
    nodes: [activityNode('convert', 'Convert document', 'documents.convert', { value: { literal: 3 } })],
    edges: [],
  } });
  await assert.rejects(f.act('saveWorkflow', { projectId: f.projects.documents.id, workflow: {
    id: 'invalid-document-binding', name: 'Invalid document binding',
    nodes: [
      activityNode('source', 'Convert amount', 'documents.convert', { value: { literal: 2 } }),
      activityNode('sink', 'Expect text', 'documents.expect-label', { value: { from: { kind: 'activity_output', nodeId: 'source', path: ['value'] } } }),
    ],
    edges: [{ from: 'source', to: 'sink', outcome: 'success' }],
  } }), /incompatible/);
  assert.deepEqual(dispatchLog, []);
  const started = await f.act('startWorkflowRun', { projectId: f.projects.documents.id, workflowId: 'pinned-document-conversion', workflowVersion: 1 });
  await waitForRun(f.act, started.workflowRunId, run => run.status === 'completed');
  await f.restart({ omitActivities: true });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.documents.id, projectId: f.projects.documents.id } });
  const snapshot = await f.snapshot();
  const unavailable = snapshot.workflowActivities.find(value => value.ref.id === 'documents.convert' && value.ref.revision === 1);
  assert.ok(unavailable);
  assert.equal(unavailable.available, false);
  const unavailableRun = await f.act('startWorkflowRun', { projectId: f.projects.documents.id, workflowId: 'pinned-document-conversion', workflowVersion: 1 });
  const failed = await waitForRun(f.act, unavailableRun.workflowRunId, run => run.status === 'failed');
  assert.equal(failed.attempt.nodeId, 'convert');
  assert.equal(failed.attempt.status, 'failed');
  assert.deepEqual(dispatchLog, ['convert']);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('a mixed no-resource run waits at a later runner activity; ack loss recovers the same external effect without replay', async t => {
  let writes = 0;
  const externalReceipts = [];
  let dispatches = 0;
  const inputSchema = { type: 'object', properties: { batchId: { type: 'string', maxLength: 80 }, count: integer(1, 10000), body: { type: 'string', maxLength: 8000 } }, required: ['batchId', 'count', 'body'], additionalProperties: false };
  const outputSchema = { type: 'object', properties: { receiptId: { type: 'string', maxLength: 120 }, batchId: { type: 'string', maxLength: 80 }, count: integer(1, 10000) }, required: ['receiptId', 'batchId', 'count'], additionalProperties: false };
  const registration = {
    descriptor: descriptor('inventory.commit-batch', 1, inputSchema, outputSchema, {
      effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
    }),
    implementation: {
      async prepare(input, identity) { return { preparedInput: input, requestId: identity.idempotencyKey }; },
      async dispatch(_context, input) {
        dispatches += 1;
        if (input.batchId === 'batch-no-receipt')
          throw new Error('Acknowledgement lost before any matching integration receipt was recorded.');
        writes += 1;
        const receipt = { receiptId: `receipt-${writes}`, batchId: input.batchId, count: input.count };
        externalReceipts.push(receipt);
        throw new Error('Acknowledgement lost after the integration accepted the batch.');
      },
      async confirm() { return { state: 'completed', output: externalReceipts[0] }; },
      async reconcile(_context, _input, intent, request) {
        const receipt = externalReceipts.find(value => value.batchId === intent.preparedInput.batchId);
        return request.requestedResolution === 'applied' && receipt
          ? { state: 'applied', output: structuredClone(receipt) }
          : { state: 'unknown', message: 'The integration has no matching receipt.' };
      },
    },
  };
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  const longReplyBody = `Vendor batch acceptance notes: ${'verified packaging, quantity, and delivery window. '.repeat(100)}`;
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: {
    id: 'mixed-inventory-review', name: 'Mixed inventory review',
    nodes: [
      activityNode('summarize', 'Summarize inventory', 'data.multiply', {
        amount: { literal: 12 }, factor: { literal: 2 },
      }),
      activityNode('inspect', 'Inspect repository', 'runner.inspect-changes', {
        ignoreArtifact: { literal: 'evidence.json' },
      }),
    ],
    edges: [{ from: 'summarize', to: 'inspect', outcome: 'success' }],
  } });
  const mixed = await f.act('startWorkflowRun', { projectId: f.projects.procurement.id, workflowId: 'mixed-inventory-review', workflowVersion: 1 });
  const waiting = await waitForRun(f.act, mixed.workflowRunId, run => run.nodeId === 'inspect' && run.attempt?.status === 'waiting');
  assert.notEqual(waiting.status, 'failed');
  assert.notEqual(waiting.status, 'completed');
  assert.equal(dispatches, 0);
  assert.equal((await f.snapshot()).sessions.length, 0);

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: {
    id: 'inventory-write', name: 'Inventory write',
    nodes: [
      { id: 'review', kind: 'human', name: 'Review batch', prompt: 'Approve the exact inventory batch.' },
      activityNode('commit', 'Commit batch', 'inventory.commit-batch', {
        batchId: { literal: 'batch-2026-10' }, count: { literal: 23 }, body: { literal: longReplyBody },
      }),
    ],
    edges: [{ from: 'review', to: 'commit', outcome: 'approved' }],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.projects.procurement.id, workflowId: 'inventory-write', workflowVersion: 1 });
  const gate = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  await f.act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  const prepared = await f.act('prepareWorkflowActivity', {
    workflowRunId: started.workflowRunId, gateInstance: gate.instance, targetNodeId: 'commit',
  });
  assert.equal(prepared.preview.activity, 'inventory.commit-batch');
  assert.equal(prepared.preview.input.body, longReplyBody);
  assert.equal(prepared.preview.intent.preparedInput.body, longReplyBody);
  await f.act('decideWorkflowRun', {
    workflowRunId: started.workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest,
  });
  const uncertain = await waitForRun(f.act, started.workflowRunId, run => run.status === 'failed' || run.status === 'interrupted');
  const instance = uncertain.instance;
  const effectKey = `${started.workflowRunId}:${instance}:commit`;
  assert.equal(uncertain.attempt.status, 'uncertain');
  assert.equal(uncertain.attempt.activityRef.id, 'inventory.commit-batch');
  assert.equal(dispatches, 1);
  const beforeRestart = await f.readPersisted();
  assert.equal(beforeRestart.workflowRuns[started.workflowRunId].flow.history.at(-1).activityReservationId, prepared.id);
  assert.equal(beforeRestart.workflowRuns[started.workflowRunId].flow.history.at(-1).activityReservationDigest, prepared.digest);
  assert.equal(beforeRestart.workflowRuns[started.workflowRunId].attempt.effectKey, effectKey);
  assert.deepEqual(beforeRestart.workflowRuns[started.workflowRunId].attempt.intent, prepared.preview.intent);
  assert.equal(beforeRestart.workflowRuns[started.workflowRunId].attempt.idempotencyKey, prepared.preview.intent.requestId);

  await f.restart();
  const recovered = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(recovered.instance, instance);
  assert.equal(recovered.attempt.status, 'uncertain');
  const afterRestart = await f.readPersisted();
  assert.equal(afterRestart.workflowRuns[started.workflowRunId].attempt.effectKey, effectKey);
  await f.act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await assert.rejects(f.act('reconcileWorkflowRun', {
    workflowRunId: started.workflowRunId, instance, effectKey, resolution: 'applied',
    result: { receiptId: 'forged', batchId: 'wrong-batch', count: 999 },
  }), /canonical activity receipt|does not match/i);
  const afterForgedResult = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(afterForgedResult.attempt.status, 'uncertain');
  assert.equal(afterForgedResult.attempt.outputDigest, undefined);
  await f.act('reconcileWorkflowRun', { workflowRunId: started.workflowRunId, instance, effectKey, resolution: 'applied' });
  const reconciled = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(reconciled.attempt.outputDigest?.length, 64);
  assert.equal(dispatches, 1);
  assert.equal(writes, 1);
  assert.deepEqual((await f.readPersisted()).workflowRuns[started.workflowRunId].attempt.output, externalReceipts[0]);

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: {
    id: 'inventory-write-no-receipt', name: 'Inventory write with no receipt',
    nodes: [
      { id: 'review', kind: 'human', name: 'Review batch', prompt: 'Approve the exact inventory batch.' },
      activityNode('commit', 'Commit batch', 'inventory.commit-batch', {
        batchId: { literal: 'batch-no-receipt' }, count: { literal: 4 }, body: { literal: 'No matching receipt exists.' },
      }),
    ],
    edges: [{ from: 'review', to: 'commit', outcome: 'approved' }],
  } });
  const noReceiptStart = await f.act('startWorkflowRun', { projectId: f.projects.procurement.id, workflowId: 'inventory-write-no-receipt', workflowVersion: 1 });
  const noReceiptGate = await f.act('getWorkflowRun', { workflowRunId: noReceiptStart.workflowRunId });
  await f.act('claimWorkflowRun', { workflowRunId: noReceiptStart.workflowRunId });
  const noReceiptPrepared = await f.act('prepareWorkflowActivity', {
    workflowRunId: noReceiptStart.workflowRunId, gateInstance: noReceiptGate.instance, targetNodeId: 'commit',
  });
  assert.equal(noReceiptPrepared.preview.input.batchId, 'batch-no-receipt');
  await f.act('decideWorkflowRun', {
    workflowRunId: noReceiptStart.workflowRunId, instance: noReceiptGate.instance, decision: 'approve',
    activityReservationId: noReceiptPrepared.id, activityReservationDigest: noReceiptPrepared.digest,
  });
  const noReceiptUncertain = await waitForRun(f.act, noReceiptStart.workflowRunId, run => run.status === 'failed' || run.status === 'interrupted');
  const noReceiptInstance = noReceiptUncertain.instance;
  const noReceiptEffectKey = `${noReceiptStart.workflowRunId}:${noReceiptInstance}:commit`;
  assert.equal(noReceiptUncertain.attempt.status, 'uncertain');
  assert.equal(dispatches, 2);
  assert.equal(writes, 1);
  await f.restart();
  await f.act('claimWorkflowRun', { workflowRunId: noReceiptStart.workflowRunId });
  await assert.rejects(f.act('reconcileWorkflowRun', {
    workflowRunId: noReceiptStart.workflowRunId, instance: noReceiptInstance, effectKey: noReceiptEffectKey,
    resolution: 'applied', result: { receiptId: 'forged', batchId: 'batch-no-receipt', count: 4 },
  }), /receipt|confirm|match|applied/i);
  const stillUncertain = await f.act('getWorkflowRun', { workflowRunId: noReceiptStart.workflowRunId });
  assert.equal(stillUncertain.attempt.status, 'uncertain');
  assert.equal(stillUncertain.attempt.outputDigest, undefined);
  assert.equal(dispatches, 2);
  assert.equal(writes, 1);
  const state = await f.persisted();
  assert.deepEqual(state.workflowRuns[started.workflowRunId].attempt.output, externalReceipts[0]);
  assert.equal(state.workflowRuns[started.workflowRunId].attempt.output.batchId, 'batch-2026-10');
  assert.equal(Object.keys(state.sessions).length, 0);
});
