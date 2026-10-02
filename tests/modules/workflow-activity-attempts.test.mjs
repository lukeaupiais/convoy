import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActivityCatalog,
  createWorkflows,
  defaultWorkflowDefinition,
  normalizeWorkflow,
} from '../../apps/daemon/src/modules/workflows/index.mjs';

const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const text = maxLength => ({ type: 'string', maxLength });

const descriptors = [
  {
    ref: { id: 'procurement.vendor-assessment', revision: 1 },
    inputSchema: object({
      supplierCode: text(24),
      signals: { type: 'array', items: text(48), maxItems: 8 },
    }, ['supplierCode', 'signals']),
    outputSchema: object({
      risk: { type: 'string', enum: ['low', 'high'] },
      evidenceCount: { type: 'integer', minimum: 0, maximum: 20 },
    }, ['risk']),
    resources: { location: 'daemon' }, effect: 'durable-effect',
    approval: { required: false }, cancellation: 'reconcile-after-dispatch',
    confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Assess vendor' },
  },
  {
    ref: { id: 'documents.extract-sections', revision: 1 },
    inputSchema: object({
      pageCount: { type: 'integer', minimum: 1, maximum: 100 },
      source: { type: 'string', enum: ['upload', 'archive'] },
    }, ['pageCount', 'source']),
    outputSchema: object({
      kind: { type: 'string', enum: ['invoice', 'policy'] },
      sections: { type: 'array', items: object({ title: text(80) }, ['title']), maxItems: 16 },
    }, ['kind', 'sections']),
    resources: { location: 'daemon' }, effect: 'durable-effect',
    approval: { required: false }, cancellation: 'reconcile-after-dispatch',
    confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Extract document sections' },
  },
];

const catalog = createActivityCatalog(descriptors);

function fixture({ activityId = 'procurement.vendor-assessment', runId = 'run-vendor', instance = 'instance-vendor' } = {}) {
  const ref = { id: activityId, revision: 1 };
  const nodeId = activityId === 'procurement.vendor-assessment' ? 'assess-vendor' : 'extract-document';
  const descriptor = catalog.get(ref);
  const literals = activityId === 'procurement.vendor-assessment'
    ? { supplierCode: 'SUP-42', signals: ['late delivery', 'missing form'] }
    : { pageCount: 12, source: 'upload' };
  const workflow = normalizeWorkflow({
    id: `flow-${nodeId}`, name: `Workflow for ${nodeId}`,
    nodes: [{ id: nodeId, name: descriptor.presentation.label, kind: 'action', activity: ref,
      bindings: Object.fromEntries(Object.entries(literals).map(([key, literal]) => [key, { literal }])) }],
  });
  const run = {
    id: runId, independentRun: true, projectId: `project-${nodeId}`, organizationId: `org-${nodeId}`,
    principal: { kind: 'user', userId: `operator-${nodeId}` }, workflow,
    flow: { id: runId, workflowId: workflow.id, workflowVersion: 1, status: 'running', nodeId, instance, history: [] },
    attempt: { nodeId, instance, status: 'ready' }, runInput: {}, activityOutputs: {},
  };
  const state = { projects: [], workflowRuns: { [run.id]: run }, workflows: [], workflowDrafts: {} };
  let saves = 0;
  const owner = createWorkflows({
    state, save: async () => { saves += 1; }, defaultWorkflow: defaultWorkflowDefinition,
    normalize: normalizeWorkflow, validateBindings: () => {}, engine: {}, effects: {},
    requestStop: async () => {}, automations: { snapshot: () => ({}) }, activityCatalog: catalog,
  });
  const input = Object.fromEntries(Object.entries(literals));
  const intent = activityId === 'procurement.vendor-assessment'
    ? { operation: 'record-assessment', requestId: 'assessment-req-1' }
    : { operation: 'extract-sections', requestId: 'document-req-1' };
  const identity = {
    instance, nodeId, ref, input, intent,
    idempotencyKey: `${run.id}:${instance}`,
  };
  return {
    owner, run, state, identity,
    get saves() { return saves; },
  };
}

async function dispatchIntent(f, identity = f.identity) {
  await f.owner.recordActivityIntent(f.run, identity);
  await f.owner.markActivityDispatchStarted(f.run, {
    instance: identity.instance, nodeId: identity.nodeId, ref: identity.ref,
  });
}

test('attempt intent is bound to the exact run, node, instance, activity, input, intent and idempotency key', async () => {
  const f = fixture();
  const other = fixture({ activityId: 'documents.extract-sections', runId: 'run-document', instance: 'instance-document' });

  const effectKey = await f.owner.recordActivityIntent(f.run, f.identity);
  assert.equal(effectKey, 'run-vendor:instance-vendor:assess-vendor');
  assert.equal(f.run.attempt.status, 'ready');
  assert.equal(f.run.attempt.dispatchStarted, false);
  assert.equal(f.run.attempt.activityRef.id, 'procurement.vendor-assessment');
  assert.equal(f.run.attempt.idempotencyKey, 'run-vendor:instance-vendor');
  assert.equal(f.owner.effectForAttempt(f.run.id, f.identity.instance, f.identity.nodeId).status, 'prepared');

  for (const mutation of [
    { ...f.identity, instance: 'stale-instance' },
    { ...f.identity, nodeId: 'other-node' },
    { ...f.identity, ref: { id: 'documents.extract-sections', revision: 1 } },
    { ...f.identity, input: { supplierCode: 'SUP-42', signals: ['late delivery'], extra: true } },
    { ...f.identity, intent: { ...f.identity.intent, requestId: 'different-request' } },
    { ...f.identity, idempotencyKey: 'different-key' },
  ]) {
    const before = structuredClone(f.state);
    const savesBefore = f.saves;
    await assert.rejects(f.owner.recordActivityIntent(f.run, mutation));
    assert.deepEqual(f.state, before, 'rejected intent mutation must leave owner state untouched');
    assert.equal(f.saves, savesBefore, 'rejected intent mutation must not persist');
  }

  for (const mutation of [
    { instance: 'stale-instance', nodeId: f.identity.nodeId, ref: f.identity.ref },
    { instance: f.identity.instance, nodeId: 'other-node', ref: f.identity.ref },
    { instance: f.identity.instance, nodeId: f.identity.nodeId, ref: other.identity.ref },
  ]) {
    const before = structuredClone(f.state);
    const savesBefore = f.saves;
    await assert.rejects(f.owner.markActivityDispatchStarted(f.run, mutation));
    assert.deepEqual(f.state, before, 'a mismatched dispatch identity must not mutate the owner');
    assert.equal(f.saves, savesBefore, 'a mismatched dispatch identity must not persist');
  }
  await f.owner.markActivityDispatchStarted(f.run, {
    instance: f.identity.instance, nodeId: f.identity.nodeId, ref: f.identity.ref,
  });
  assert.equal(f.run.attempt.status, 'running');
  assert.equal(f.run.attempt.dispatchStarted, true);
  assert.equal(f.owner.effectForAttempt(f.run.id, f.identity.instance, f.identity.nodeId).status, 'pending');

  const documentKey = await other.owner.recordActivityIntent(other.run, other.identity);
  assert.equal(other.run.attempt.status, 'ready');
  assert.equal(documentKey, 'run-document:instance-document:extract-document');
  assert.notDeepEqual(f.run.attempt.inputDigest, other.run.attempt.inputDigest);
  assert.notDeepEqual(f.run.attempt.activityRef, other.run.attempt.activityRef);
});

test('first intent reservation rejects a registered activity revision different from the node pin', async () => {
  const f = fixture({ runId: 'run-unreserved', instance: 'instance-unreserved' });
  const wrongPinnedRef = {
    ...f.identity,
    ref: { id: 'documents.extract-sections', revision: 1 },
    input: { pageCount: 12, source: 'upload' },
    intent: { operation: 'extract-sections', requestId: 'foreign-ref-request' },
  };
  const before = structuredClone(f.state);
  const savesBefore = f.saves;
  await assert.rejects(f.owner.recordActivityIntent(f.run, wrongPinnedRef), /activity|pinned|revision/i);
  assert.deepEqual(f.state, before);
  assert.equal(f.saves, savesBefore);
});

test('first intent reservation rejects schema-valid input that differs from its declared bindings', async () => {
  const f = fixture({ runId: 'run-bound-input', instance: 'instance-bound-input' });
  const changedInput = {
    ...f.identity,
    input: { supplierCode: 'OTHER', signals: ['late delivery', 'missing form'] },
  };
  const before = structuredClone(f.state);
  const savesBefore = f.saves;
  await assert.rejects(f.owner.recordActivityIntent(f.run, changedInput), /input|binding|identity/i);
  assert.deepEqual(f.state, before);
  assert.equal(f.saves, savesBefore);
});

test('first intent reservation requires the run and instance idempotency identity', async () => {
  const f = fixture({ runId: 'run-canonical-key', instance: 'instance-canonical-key' });
  const changedKey = { ...f.identity, idempotencyKey: 'adapter-owned-key' };
  const before = structuredClone(f.state);
  const savesBefore = f.saves;
  await assert.rejects(f.owner.recordActivityIntent(f.run, changedKey), /idempotency|identity|key/i);
  assert.deepEqual(f.state, before);
  assert.equal(f.saves, savesBefore);
});

test('completed receipts accept semantically identical canonical JSON duplicates', async () => {
  const f = fixture();
  await dispatchIntent(f);
  const output = { risk: 'high', evidenceCount: 3 };
  await f.owner.recordActivityResult(f.run, { ...f.identity, output, status: 'completed' });
  const receipt = structuredClone(f.run.attempt);
  const ledgerReceipt = f.owner.effectForAttempt(f.run.id, f.identity.instance, f.identity.nodeId);

  await f.owner.recordActivityResult(f.run, { ...f.identity, output: { evidenceCount: 3, risk: 'high' }, status: 'completed' });
  assert.deepEqual(f.run.attempt, receipt);
  assert.deepEqual(f.owner.effectForAttempt(f.run.id, f.identity.instance, f.identity.nodeId), ledgerReceipt);
});

test('completed receipts reject changed output, state, or not-applied reconciliation before mutation', async () => {
  const f = fixture();
  await dispatchIntent(f);
  const output = { risk: 'high', evidenceCount: 3 };
  await f.owner.recordActivityResult(f.run, { ...f.identity, output, status: 'completed' });
  const receipt = structuredClone(f.run.attempt);

  for (const changed of [
    { ...f.identity, output: { risk: 'low', evidenceCount: 3 }, status: 'completed' },
    { ...f.identity, output, status: 'waiting' },
  ]) {
    const before = structuredClone(f.state);
    const savesBefore = f.saves;
    await assert.rejects(f.owner.recordActivityResult(f.run, changed), /immutable|cannot change/i);
    assert.deepEqual(f.state, before);
    assert.equal(f.saves, savesBefore);
  }
  const savesBeforeReconcile = f.saves;
  await assert.rejects(f.owner.reconcileActivityAttempt(f.run, {
    instance: f.identity.instance, nodeId: f.identity.nodeId, ref: f.identity.ref, state: 'not_applied',
  }), /cannot be reconciled away/i);
  assert.deepEqual(f.run.attempt, receipt);
  assert.equal(f.saves, savesBeforeReconcile);

  const document = fixture({ activityId: 'documents.extract-sections', runId: 'run-document-complete', instance: 'instance-document-complete' });
  await dispatchIntent(document);
  const documentOutput = { kind: 'invoice', sections: [{ title: 'Totals' }] };
  await document.owner.recordActivityResult(document.run, { ...document.identity, output: documentOutput, status: 'completed' });
  assert.deepEqual(document.run.attempt.output, documentOutput);
  assert.equal(document.run.attempt.outputDigest.length, 64);
});

test('cancelled owner state rejects late callbacks and uncertain durable effects change only through reconciliation', async () => {
  const cancelled = fixture({ runId: 'run-cancelled', instance: 'instance-cancelled' });
  await dispatchIntent(cancelled);
  cancelled.run.flow.status = 'cancelled';
  cancelled.run.attempt.status = 'cancelled';
  const beforeCancelledCallback = structuredClone(cancelled.state);
  const cancelledSaves = cancelled.saves;
  await assert.rejects(cancelled.owner.recordActivityResult(cancelled.run, {
    ...cancelled.identity, output: { risk: 'high', evidenceCount: 1 }, status: 'completed',
  }), /terminal activity attempt/i);
  assert.deepEqual(cancelled.state, beforeCancelledCallback);
  assert.equal(cancelled.saves, cancelledSaves);

  const uncertain = fixture({ runId: 'run-uncertain', instance: 'instance-uncertain' });
  await dispatchIntent(uncertain);
  await uncertain.owner.recordActivityResult(uncertain.run, {
    ...uncertain.identity, status: 'uncertain', message: 'Adapter response was lost.',
  });
  const uncertainState = structuredClone(uncertain.state);
  const uncertainSaves = uncertain.saves;
  await assert.rejects(uncertain.owner.recordActivityResult(uncertain.run, {
    ...uncertain.identity, output: { risk: 'high', evidenceCount: 1 }, status: 'completed',
  }), /terminal activity attempt/i);
  assert.deepEqual(uncertain.state, uncertainState);
  assert.equal(uncertain.saves, uncertainSaves);

  await uncertain.owner.reconcileActivityAttempt(uncertain.run, {
    instance: uncertain.identity.instance, nodeId: uncertain.identity.nodeId, ref: uncertain.identity.ref,
    state: 'applied', output: { risk: 'high', evidenceCount: 1 },
  });
  assert.equal(uncertain.run.attempt.status, 'completed');
  assert.equal(uncertain.owner.effectForAttempt(uncertain.run.id, uncertain.identity.instance, uncertain.identity.nodeId).status, 'succeeded');
  const completed = structuredClone(uncertain.run.attempt);
  await assert.rejects(uncertain.owner.reconcileActivityAttempt(uncertain.run, {
    instance: uncertain.identity.instance, nodeId: uncertain.identity.nodeId, ref: uncertain.identity.ref,
    state: 'not_applied',
  }), /cannot be reconciled away/i);
  assert.deepEqual(uncertain.run.attempt, completed);
});

test('waiting observations can advance only from their exact prior digest without changing dispatch identity', async () => {
  const f = fixture({ activityId: 'documents.extract-sections', runId: 'run-waiting', instance: 'instance-waiting' });
  await dispatchIntent(f);
  const identity = Object.fromEntries(['activityRef', 'inputDigest', 'intentDigest', 'idempotencyKey', 'effectKey', 'intent']
    .map(key => [key, structuredClone(f.run.attempt[key]) ]));
  const firstObservation = { kind: 'invoice', sections: [{ title: 'Page 1' }] };
  await f.owner.recordActivityResult(f.run, {
    ...f.identity, status: 'waiting', output: firstObservation,
  });
  const firstDigest = f.run.attempt.waitingOutputDigest;
  assert.equal(firstDigest.length, 64);

  const beforeStaleConfirmation = structuredClone(f.state);
  const beforeStaleSaveCount = f.saves;
  await assert.rejects(f.owner.recordActivityResult(f.run, {
    ...f.identity, status: 'waiting', output: { kind: 'invoice', sections: [{ title: 'Totals' }] },
    expectedWaitingOutputDigest: 'stale-observation',
  }), /observation changed/i);
  assert.deepEqual(f.state, beforeStaleConfirmation);
  assert.equal(f.saves, beforeStaleSaveCount);

  const nextObservation = { kind: 'invoice', sections: [{ title: 'Page 1' }, { title: 'Totals' }] };
  await f.owner.recordActivityResult(f.run, {
    ...f.identity, status: 'waiting', output: nextObservation, expectedWaitingOutputDigest: firstDigest,
  });
  assert.deepEqual(f.run.attempt.waitingOutput, nextObservation);
  for (const [key, value] of Object.entries(identity)) assert.deepEqual(f.run.attempt[key], value, `${key} remains pinned during confirmation`);
  const effect = f.owner.effectForAttempt(f.run.id, f.identity.instance, f.identity.nodeId);
  assert.equal(effect.status, 'pending');
  assert.deepEqual(effect.result, nextObservation);
});
