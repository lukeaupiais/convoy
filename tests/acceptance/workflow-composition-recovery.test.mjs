import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { activityDigest, createWorkflows, normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/index.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });

async function waitFor(read, predicate, message, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

function activity(id, inputSchema, outputSchema, implementation) {
  return {
    descriptor: {
      ref: { id, revision: 1 }, inputSchema, outputSchema,
      resources: { location: 'integration', adapterId: 'composition-recovery-test' },
      effect: 'pure', approval: { required: false }, cancellation: 'immediate',
      confirmation: 'result', reconciliation: 'none', presentation: { label: id },
    },
    implementation,
  };
}

async function fixture(t, { workflowActivities = [], generate } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-recovery-'));
  const options = {
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: generate ?? (async function* () { assert.fail('No recovery case should generate provider output.'); }),
    runners: { execute: async () => assert.fail('No recovery case should acquire a runner.'), close: async () => {} },
    workflowActivities,
  };
  let runtime = await createRuntime(options);
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = 'workflow-composition-recovery-acceptance';
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const organization = await act('createOrganization', {
    slug: `composition-recovery-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Composition recovery', kind: 'team',
  });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Recovery project' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  return {
    client, directory, options, organization, project, act,
    save: workflow => act('saveWorkflow', { projectId: project.id, workflow }),
    start: (workflow, runInput = {}, principal) => act('startWorkflowRun', {
      projectId: project.id, workflowId: workflow.id, workflowVersion: workflow.version, runInput,
    }, principal),
    readRun: workflowRunId => act('getWorkflowRun', { workflowRunId }),
    readState: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')),
    snapshot: () => runtime.snapshot(undefined, client),
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
    async close() { await runtime?.close(); runtime = null; },
    async reopen() { runtime = await createRuntime(options); },
  };
}

function echoRegistration(calls) {
  const inputSchema = object({ label: text(80), sequence: { type: 'integer', minimum: 0, maximum: 200 } }, ['label', 'sequence']);
  const outputSchema = object({ label: text(80), sequence: { type: 'integer', minimum: 0, maximum: 200 } }, ['label', 'sequence']);
  return activity('recovery.echo', inputSchema, outputSchema, {
    async prepare(input) { return structuredClone(input); },
    async dispatch(_context, input) { calls.push(structuredClone(input)); return { state: 'completed', output: structuredClone(input) }; },
  });
}

function childDefinition(projectId, workflowId = 'recovery-echo-child') {
  const schema = object({ label: text(80), sequence: { type: 'integer', minimum: 0, maximum: 200 } }, ['label', 'sequence']);
  return {
    id: workflowId, name: workflowId, projectId, runInputSchema: schema, resultSchema: schema,
    resultBindings: {
      label: { from: { kind: 'activity_output', nodeId: 'echo', path: ['label'] } },
      sequence: { from: { kind: 'activity_output', nodeId: 'echo', path: ['sequence'] } },
    },
    nodes: [{ id: 'echo', name: 'Echo', kind: 'action', activity: { id: 'recovery.echo', revision: 1 }, bindings: {
      label: { from: { kind: 'run_input', path: ['label'] } },
      sequence: { from: { kind: 'run_input', path: ['sequence'] } },
    } }], edges: [],
  };
}

function counterActivity(directory, id) {
  const schema = object({ label: text(80) }, ['label']);
  const countsPath = join(directory, 'dispatch-counts.json');
  return activity(id, schema, schema, {
    async prepare(input) { return structuredClone(input); },
    async dispatch(_context, input) {
      const counts = JSON.parse(await readFile(countsPath, 'utf8').catch(() => '{}'));
      counts[id] = (counts[id] ?? 0) + 1;
      await writeFile(countsPath, JSON.stringify(counts));
      return { state: 'completed', output: structuredClone(input) };
    },
  });
}

test('a new canonical composition attempt appends after retained history beyond 100 and pages by offset', async t => {
  const calls = [];
  const echo = echoRegistration(calls);
  const f = await fixture(t, { workflowActivities: [echo] });
  const child = await f.save(childDefinition(f.project.id));
  const seedParent = await f.save({ id: 'recovery-history-seed', name: 'Seed canonical composition history', projectId: f.project.id,
    nodes: [{ id: 'seed-child', name: 'Seed child', kind: 'child', workflow: { id: child.id, version: child.version },
      inputBindings: { label: { literal: 'seed' }, sequence: { literal: 0 } }, outputSchema: child.resultSchema,
      outputBindings: { label: { from: ['label'] }, sequence: { from: ['sequence'] } } }], edges: [],
  });
  const seeded = await f.start(seedParent);
  await waitFor(() => f.readRun(seeded.workflowRunId), run => run.status === 'completed', 'seed composition did not complete');
  const seedAttempt = (await f.readState()).workflowRuns[seeded.workflowRunId].compositionAttempts[0];
  const pendingParent = await f.save({
    id: 'recovery-history-append', name: 'Append to retained composition history', projectId: f.project.id,
    nodes: [
      { id: 'review', name: 'Review', kind: 'human', humanTask: {
        outcomes: [{ id: 'approved', label: 'Continue' }, { id: 'rejected', label: 'Stop' }],
        form: { fields: [{ id: 'note', label: 'Note', type: 'text', required: false, maxLength: 80 }] },
      } },
      { id: 'next-child', name: 'Next child', kind: 'child', workflow: { id: child.id, version: child.version },
        inputBindings: { label: { literal: 'after-history' }, sequence: { literal: 101 } }, outputSchema: child.resultSchema,
        outputBindings: { label: { from: ['label'] }, sequence: { from: ['sequence'] } } },
    ], edges: [
      { from: 'review', to: 'next-child', outcome: 'approved' },
      { from: 'review', to: 'next-child', outcome: 'rejected' },
    ],
  });
  const { workflowRunId } = await f.start(pendingParent);
  const gate = await f.readRun(workflowRunId);
  assert.equal(gate.status, 'waiting_gate');
  // The older canonical history came from a real completed attempt above. This
  // fixture models an imported long-lived run; the next attempt is created only
  // through the public runtime after restart.
  await f.close();
  const statePath = join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const historical = Array.from({ length: 101 }, (_, index) => {
    const value = structuredClone(seedAttempt);
    value.nodeId = `retained-historical-${index}`;
    value.instance = `retained-history-instance-${index}`;
    value.slots = value.slots.map(slot => ({ ...slot, slotId: `${slot.slotId}-history-${index}`, runId: `${slot.runId}-history-${index}` }));
    return value;
  });
  state.workflowRuns[workflowRunId].compositionAttempts = historical;
  await writeFile(statePath, JSON.stringify(state));
  await f.reopen();
  await f.act('claimWorkflowRun', { workflowRunId });
  const freshGate = await f.readRun(workflowRunId);
  const response = await f.act('submitWorkflowHumanResponse', { workflowRunId, instance: freshGate.instance, values: { note: 'continue' } });
  const review = await f.act('prepareWorkflowHumanReview', { workflowRunId, instance: freshGate.instance, responseId: response.id, outcomeId: 'approved', targetNodeId: 'next-child' });
  await f.act('decideWorkflowRun', { workflowRunId, instance: freshGate.instance, responseId: response.id, outcomeId: 'approved', reviewedMaterialDigest: review.materialDigest });
  const completed = await waitFor(() => f.readRun(workflowRunId), run => run.status === 'completed', 'appended child composition did not complete');
  assert.equal(calls.length, 2, 'only the real seed and post-restart child dispatched');
  const stored = await f.readState().then(value => value.workflowRuns[workflowRunId]);
  assert.equal(stored.compositionAttempts.length, 102, 'the next public composition appends instead of trimming prior attempts');
  assert.equal(stored.compositionAttempts.at(-1).nodeId, 'next-child');
  assert.equal(new Set(stored.compositionAttempts.map(attempt => attempt.instance)).size, 102);
  const oldest = await f.act('getWorkflowRun', { workflowRunId, compositionOffset: 0 });
  assert.equal(oldest.compositionAttemptsTotal, 102);
  assert.equal(oldest.compositionAttemptsOffset, 0);
  assert.equal(oldest.compositions.length, 50);
  assert.equal(oldest.compositions[0].nodeId, 'retained-historical-0');
  assert.equal(oldest.compositionAttemptsHasMore, true);
  const newest = await f.act('getWorkflowRun', { workflowRunId, compositionOffset: 101 });
  assert.equal(newest.compositionAttemptsTotal, 102);
  assert.equal(newest.compositionAttemptsOffset, 101);
  assert.equal(newest.compositions.length, 1);
  assert.equal(newest.compositions[0].nodeId, 'next-child');
  assert.equal(newest.compositionAttemptsHasMore, false);
  assert.equal(completed.compositions.length, 50, 'default read page is bounded');
});

test('snapshot keeps a cancelled parent with a real uncertain child ahead of more than 200 clean terminal runs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-recovery-uncertain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'receipt.json');
  const readReceipt = async () => JSON.parse(await readFile(receiptPath, 'utf8').catch(() => '{"calls":0,"receipt":null}'));
  const writeReceipt = value => writeFile(receiptPath, JSON.stringify(value));
  const inputSchema = object({ recordId: text(80) }, ['recordId']);
  const outputSchema = object({ receiptId: text(100) }, ['receiptId']);
  const uncertain = activity('recovery.apply-change', inputSchema, outputSchema, {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, input }; },
    async dispatch(_context, input, intent) {
      const receipt = await readReceipt(); receipt.calls += 1; receipt.receipt ??= { receiptId: `apply:${input.recordId}` };
      await writeReceipt(receipt);
      throw new Error('The durable operation applied but acknowledgement was lost.');
    },
    async confirm() { return { state: 'waiting' }; },
    async reconcile() { return { state: 'unknown' }; },
  });
  uncertain.descriptor.effect = 'durable-effect';
  uncertain.descriptor.cancellation = 'reconcile-after-dispatch';
  uncertain.descriptor.confirmation = 'adapter-confirmed';
  uncertain.descriptor.reconciliation = 'adapter';
  const f = await fixture(t, { workflowActivities: [uncertain] });
  const child = await f.save({ id: 'recovery-uncertain-child', name: 'Uncertain child', projectId: f.project.id,
    runInputSchema: inputSchema, resultSchema: outputSchema,
    resultBindings: { receiptId: { from: { kind: 'activity_output', nodeId: 'write', path: ['receiptId'] } } },
    nodes: [{ id: 'write', name: 'Write', kind: 'action', activity: uncertain.descriptor.ref,
      bindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } } }], edges: [],
  });
  const schema = inputSchema;
  const parent = await f.save({ id: 'recovery-uncertain-parent', name: 'Uncertain parent', projectId: f.project.id,
    runInputSchema: schema,
    nodes: [{ id: 'child', name: 'Child', kind: 'child', workflow: { id: child.id, version: child.version },
      inputBindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } },
      outputSchema, outputBindings: { receiptId: { from: ['receiptId'] } } }], edges: [],
  });
  const { workflowRunId } = await f.start(parent, { recordId: 'uncertain-record' });
  const runningParent = await waitFor(() => f.readRun(workflowRunId), run => Boolean(run.compositions?.[0]?.slots?.[0]?.runId), 'uncertain child was not admitted');
  const childRunId = runningParent.compositions[0].slots[0].runId;
  const childRun = await waitFor(() => f.readRun(childRunId), run => run.attempt?.status === 'uncertain', 'child did not retain its unknown applied effect');
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  const cancelled = await f.readRun(workflowRunId);
  assert.equal(cancelled.status, 'cancelled');
  const canceledChild = await f.readRun(childRunId);
  assert.equal(canceledChild.attempt.status, 'uncertain');
  assert.equal(canceledChild.attempt.effectKey, childRun.attempt.effectKey);
  assert.equal((await readReceipt()).calls, 1);

  await f.close();
  const statePath = join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (let index = 0; index < 205; index += 1) {
    const id = `terminal-fixture-${String(index).padStart(3, '0')}`;
    state.workflowRuns[id] = {
      id, independentRun: true, organizationId: f.organization.id, projectId: f.project.id,
      flow: { workflowId: 'historical-completed', workflowVersion: 1, status: 'completed', history: [] },
      status: 'completed', startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    };
  }
  await writeFile(statePath, JSON.stringify(state));
  await f.reopen();
  await f.act('selectActiveContext', { context: { organizationId: f.organization.id, projectId: f.project.id } });
  const snapshot = await f.snapshot();
  assert.equal(snapshot.workflowRunsTotal, 207);
  assert.equal(snapshot.workflowRunsTruncated, true);
  assert.ok(snapshot.workflowRuns.some(run => run.id === workflowRunId), 'the unresolved cancelled parent is prioritized in the bounded read model');
  assert.ok(snapshot.workflowRuns.some(run => run.id === childRunId), 'the real uncertain child remains visible');
  assert.equal((await f.readRun(workflowRunId)).compositions[0].slots[0].runId, childRunId);
});

test('restart cancellation settles a persisted starting slot that has no child and preserves its reserved ID', async t => {
  const inputSchema = object({ recordId: text(80) }, ['recordId']);
  const outputSchema = object({ receiptId: text(100) }, ['receiptId']);
  let calls = 0;
  const durable = activity('recovery.starting-write', inputSchema, outputSchema, {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, input }; },
    async dispatch() { calls += 1; throw new Error('The durable adapter acknowledgement was lost.'); },
    async confirm() { return { state: 'waiting' }; },
    async reconcile() { return { state: 'unknown' }; },
  });
  durable.descriptor.effect = 'durable-effect';
  durable.descriptor.cancellation = 'reconcile-after-dispatch';
  durable.descriptor.confirmation = 'adapter-confirmed';
  durable.descriptor.reconciliation = 'adapter';
  const f = await fixture(t, { workflowActivities: [durable] });
  const child = await f.save({ id: 'recovery-starting-child', name: 'Starting child', projectId: f.project.id,
    runInputSchema: inputSchema, resultSchema: outputSchema,
    resultBindings: { receiptId: { from: { kind: 'activity_output', nodeId: 'write', path: ['receiptId'] } } },
    nodes: [{ id: 'write', name: 'Write', kind: 'action', activity: durable.descriptor.ref,
      bindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } } }], edges: [],
  });
  const outputItem = object({ receiptId: text(100) }, ['receiptId']);
  const parent = await f.save({ id: 'recovery-starting-parent', name: 'Starting parent', projectId: f.project.id,
    runInputSchema: object({ records: { type: 'array', items: text(80), minItems: 2, maxItems: 2 } }, ['records']),
    nodes: [{ id: 'map', name: 'Map two writes', kind: 'map', itemsBinding: { from: { kind: 'run_input', path: ['records'] } },
      itemField: 'recordId', workflow: { id: child.id, version: child.version }, inputBindings: {}, maxItems: 2, maxConcurrent: 1,
      deadlineMs: 60_000, failurePolicy: 'fail_fast', outputSchema: { type: 'array', items: outputItem }, outputBindings: { receiptId: { from: ['receiptId'] } } }], edges: [],
  });
  const started = await f.start(parent, { records: ['effect-one', 'must-not-create'] });
  const before = await waitFor(() => f.readRun(started.workflowRunId), run => run.compositions?.[0]?.slots?.[0]?.status === 'uncertain',
    'first durable child did not retain its uncertain receipt');
  const [uncertainSlot, queuedSlot] = before.compositions[0].slots;
  assert.equal(queuedSlot.status, 'queued');
  const uncertainChild = await f.readRun(uncertainSlot.runId);
  await f.close();
  const statePath = join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const owner = state.workflowRuns[started.workflowRunId];
  const slot = owner.compositionAttempts[0].slots.find(value => value.slotId === queuedSlot.slotId);
  slot.status = 'starting';
  slot.admittedAt = new Date().toISOString();
  assert.equal(slot.runId, queuedSlot.runId);
  assert.equal(slot.childRunCreated, false);
  assert.equal(state.workflowRuns[slot.runId], undefined, 'the crash fixture is exactly between durable reservation and child creation');
  await writeFile(statePath, JSON.stringify(state));
  await f.reopen();
  const recovered = await f.readRun(started.workflowRunId);
  assert.equal(recovered.compositions[0].slots[0].runId, uncertainSlot.runId);
  assert.equal(recovered.compositions[0].slots[1].runId, queuedSlot.runId);
  assert.equal(recovered.compositions[0].slots[1].childRunCreated, false);
  await f.act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId: started.workflowRunId });
  const cancelled = await f.readRun(started.workflowRunId);
  const [retainedEffect, drainedSlot] = cancelled.compositions[0].slots;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(retainedEffect.runId, uncertainSlot.runId);
  assert.equal(retainedEffect.status, 'uncertain');
  assert.equal(drainedSlot.runId, queuedSlot.runId);
  assert.equal(drainedSlot.status, 'cancelled');
  assert.equal(drainedSlot.childRunCreated, false);
  assert.equal((await f.readState()).workflowRuns[drainedSlot.runId], undefined, 'cancellation never creates the reserved child late');
  await f.restart();
  const afterSecondRestart = await f.readRun(started.workflowRunId);
  assert.equal(afterSecondRestart.compositions[0].slots[1].runId, queuedSlot.runId);
  assert.equal(afterSecondRestart.compositions[0].slots[1].status, 'cancelled');
  assert.equal((await f.readRun(uncertainSlot.runId)).attempt.effectKey, uncertainChild.attempt.effectKey);
  assert.equal(calls, 1, 'restart and parent cancellation do not replay or create descendant effects');
});

test('cancellation during the owner admission save cannot create the reserved child afterward', async () => {
  let enterSave;
  let releaseSave;
  const entered = new Promise(resolve => { enterSave = resolve; });
  const blockedSave = new Promise(resolve => { releaseSave = resolve; });
  const organizationId = 'org-admission-race';
  const projectId = 'project-admission-race';
  const principal = { kind: 'user', userId: 'local' };
  const childSchema = object({ value: text(40) }, ['value']);
  const childWorkflow = {
    id: 'admission-race-child', name: 'Admission race child', version: 1, projectId, organizationId,
    runInputSchema: childSchema, resultSchema: childSchema,
    resultBindings: { value: { from: { kind: 'run_input', path: ['value'] } } },
    nodes: [{ id: 'done', name: 'Done', kind: 'human', humanTask: {
      outcomes: [{ id: 'approved', label: 'Approved' }, { id: 'declined', label: 'Declined' }],
      form: { fields: [{ id: 'note', label: 'Note', type: 'text', required: false, maxLength: 40 }] },
    } }], edges: [],
  };
  const parentWorkflow = {
    id: 'admission-race-parent', name: 'Admission race parent', version: 1, projectId, organizationId,
    nodes: [{ id: 'compose', name: 'Compose child', kind: 'child',
      workflow: { id: childWorkflow.id, version: childWorkflow.version },
      inputBindings: { value: { literal: 'reserved' } }, outputSchema: childSchema,
      outputBindings: { value: { from: ['value'] } } }], edges: [],
  };
  const compositionLimits = {
    effective: { maxDescendantRuns: 128, maxMapItems: 100, maxConcurrentChildren: 8,
      maxDeadlineMs: 604_800_000, maxActiveDescendantRuns: 32, maxActiveDescendantsPerRoot: 8 },
    organization: { revision: 0, limits: { maxActiveDescendantRuns: 32 } },
    project: { revision: 0, limits: null },
  };
  const slot = {
    slotId: 'compose:instance-admission:child:0', runId: 'reserved-child-run', index: 0,
    status: 'queued', childRunCreated: false, workflow: { id: childWorkflow.id, version: childWorkflow.version },
    workflowDigest: activityDigest(childWorkflow), input: { value: 'reserved' }, inputDigest: activityDigest({ value: 'reserved' }),
    inputSchemaDigest: activityDigest(normalizeWorkflow(childWorkflow).runInputSchema),
    resultSchemaDigest: activityDigest(normalizeWorkflow(childWorkflow).resultSchema),
  };
  const parent = {
    id: 'admission-race-parent-run', projectId, organizationId, independentRun: true,
    principal: structuredClone(principal), executionPrincipal: structuredClone(principal),
    workflow: structuredClone(parentWorkflow), compositionRootRunId: 'admission-race-parent-run',
    compositionBudget: { reservedDescendantRuns: 1 }, status: 'running',
    attempt: { nodeId: 'compose', instance: 'instance-admission', status: 'running', effect: 'pure', dispatchStarted: false },
    flow: { workflowId: parentWorkflow.id, workflowVersion: 1, status: 'running', nodeId: 'compose', instance: 'instance-admission' },
    compositionAttempts: [{ nodeId: 'compose', instance: 'instance-admission', kind: 'child',
      rootRunId: 'admission-race-parent-run', workflow: { id: parentWorkflow.id, version: 1 },
      limits: compositionLimits.effective, slots: [slot], startedAt: new Date().toISOString(),
      status: 'running', failurePolicy: 'fail_fast' }],
  };
  const state = { workflowRuns: { [parent.id]: parent }, workflows: [childWorkflow], projects: [{ id: projectId, organizationId }],
    sessions: {}, workflowEventJournal: [], workflowDeadlines: {}, workflowWaits: {}, workflowEffectLedger: {} };
  let saves = 0;
  const save = async () => {
    saves += 1;
    if (saves === 1) { enterSave(); await blockedSave; }
  };
  const owner = createWorkflows({
    state, save, defaultWorkflow: { id: 'delivery', name: 'Delivery', nodes: [], edges: [] },
    normalize: normalizeWorkflow, validateBindings: () => {}, engine: {
      async pause(run, cancelled) { run.flow.status = cancelled ? 'cancelled' : 'paused'; run.status = run.flow.status; },
    }, effects: {}, requestStop: async () => {}, automations: {}, activityCatalog: { get: () => null },
    defaultPrincipal: principal, resolveCompositionLimits: () => compositionLimits,
  });
  const admission = owner.admitCompositionSlot({ runId: parent.id, nodeId: 'compose', instance: 'instance-admission',
    slotId: slot.slotId, limits: compositionLimits });
  let timeout;
  try {
    await Promise.race([entered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('admission did not await its save')), 2_000); })]);
    assert.equal(slot.status, 'starting');
    await owner.cancelRun(parent, parent);
    assert.equal(parent.flow.status, 'cancelled');
    releaseSave();
    const result = await admission;
    assert.equal(result.admitted, false);
    assert.equal(slot.status, 'cancelled');
    assert.equal(slot.runId, 'reserved-child-run');
    assert.equal(slot.childRunCreated, false);
    assert.equal(state.workflowRuns[slot.runId], undefined);
    assert.equal(saves, 2, 'owner durably settles the cancelled reservation after the suspended save resumes');
  } finally {
    clearTimeout(timeout);
    releaseSave();
    await admission.catch(() => {});
  }
});

test('a tightened deadline during the owner admission save expires from the original start before child creation', async () => {
  let enterSave;
  let releaseSave;
  const entered = new Promise(resolve => { enterSave = resolve; });
  const blockedSave = new Promise(resolve => { releaseSave = resolve; });
  let clock = Date.now();
  const organizationId = 'org-deadline-admission-race';
  const projectId = 'project-deadline-admission-race';
  const principal = { kind: 'user', userId: 'local' };
  const childSchema = object({ value: text(40) }, ['value']);
  const childWorkflow = {
    id: 'deadline-admission-child', name: 'Deadline admission child', version: 1, projectId, organizationId,
    runInputSchema: childSchema, resultSchema: childSchema,
    resultBindings: { value: { from: { kind: 'run_input', path: ['value'] } } },
    nodes: [{ id: 'done', name: 'Done', kind: 'human', humanTask: {
      outcomes: [{ id: 'approved', label: 'Approved' }, { id: 'declined', label: 'Declined' }],
      form: { fields: [{ id: 'note', label: 'Note', type: 'text', required: false, maxLength: 40 }] },
    } }], edges: [],
  };
  const parentWorkflow = {
    id: 'deadline-admission-parent', name: 'Deadline admission parent', version: 1, projectId, organizationId,
    nodes: [{ id: 'compose', name: 'Compose child', kind: 'child', deadlineMs: 60_000,
      workflow: { id: childWorkflow.id, version: childWorkflow.version },
      inputBindings: { value: { literal: 'reserved' } }, outputSchema: childSchema,
      outputBindings: { value: { from: ['value'] } } }], edges: [],
  };
  const makeLimits = maxDeadlineMs => ({
    effective: { maxDescendantRuns: 128, maxMapItems: 100, maxConcurrentChildren: 8,
      maxDeadlineMs, maxActiveDescendantRuns: 32, maxActiveDescendantsPerRoot: 8 },
    organization: { revision: 0, limits: { maxActiveDescendantRuns: 32 } },
    project: { revision: 0, limits: null },
  });
  const originalLimits = makeLimits(60_000);
  let currentLimits = originalLimits;
  const attemptStartedAt = new Date(clock).toISOString();
  const slot = {
    slotId: 'compose:instance-deadline-admission:child:0', runId: 'reserved-deadline-child-run', index: 0,
    status: 'queued', childRunCreated: false, workflow: { id: childWorkflow.id, version: childWorkflow.version },
    workflowDigest: activityDigest(childWorkflow), input: { value: 'reserved' }, inputDigest: activityDigest({ value: 'reserved' }),
    inputSchemaDigest: activityDigest(normalizeWorkflow(childWorkflow).runInputSchema),
    resultSchemaDigest: activityDigest(normalizeWorkflow(childWorkflow).resultSchema),
  };
  const parent = {
    id: 'deadline-admission-parent-run', projectId, organizationId, independentRun: true,
    principal: structuredClone(principal), executionPrincipal: structuredClone(principal),
    workflow: structuredClone(parentWorkflow), compositionRootRunId: 'deadline-admission-parent-run',
    compositionBudget: { reservedDescendantRuns: 1 }, status: 'running',
    attempt: { nodeId: 'compose', instance: 'instance-deadline-admission', status: 'running', effect: 'pure', dispatchStarted: false },
    flow: { workflowId: parentWorkflow.id, workflowVersion: 1, status: 'running', nodeId: 'compose', instance: 'instance-deadline-admission' },
    compositionAttempts: [{ nodeId: 'compose', instance: 'instance-deadline-admission', kind: 'child',
      rootRunId: 'deadline-admission-parent-run', workflow: { id: parentWorkflow.id, version: 1 },
      limits: originalLimits.effective, slots: [slot], startedAt: attemptStartedAt,
      deadlineAt: new Date(clock + 60_000).toISOString(), deadlineExpired: false,
      status: 'running', failurePolicy: 'fail_fast' }],
  };
  const state = { workflowRuns: { [parent.id]: parent }, workflows: [childWorkflow], projects: [{ id: projectId, organizationId }],
    sessions: {}, workflowEventJournal: [], workflowDeadlines: {}, workflowWaits: {}, workflowEffectLedger: {} };
  let saves = 0;
  const save = async () => {
    saves += 1;
    if (saves === 1) { enterSave(); await blockedSave; }
  };
  const owner = createWorkflows({
    state, save, defaultWorkflow: { id: 'delivery', name: 'Delivery', nodes: [], edges: [] },
    normalize: normalizeWorkflow, validateBindings: () => {}, engine: {
      async pause(run, cancelled) { run.flow.status = cancelled ? 'cancelled' : 'paused'; run.status = run.flow.status; },
    }, effects: {}, requestStop: async () => {}, automations: {}, activityCatalog: { get: () => null },
    defaultPrincipal: principal, resolveCompositionLimits: () => currentLimits,
    now: () => new Date(clock).toISOString(),
  });
  const admission = owner.admitCompositionSlot({ runId: parent.id, nodeId: 'compose', instance: 'instance-deadline-admission',
    slotId: slot.slotId, limits: originalLimits });
  let timeout;
  try {
    await Promise.race([entered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('admission did not await its save')), 2_000); })]);
    assert.equal(slot.status, 'starting');
    clock += 2_000;
    currentLimits = makeLimits(1_000);
    releaseSave();
    const result = await admission;
    assert.equal(result.admitted, false);
    assert.notEqual(parent.flow.status, 'cancelled', 'the deadline, rather than cancellation, blocks the resumed admission');
    assert.equal(slot.status, 'cancelled', 'the expired reserved slot is settled instead of being materialized as a child');
    assert.equal(slot.runId, 'reserved-deadline-child-run');
    assert.equal(slot.childRunCreated, false);
    assert.equal(state.workflowRuns[slot.runId], undefined);
    assert.equal(parent.compositionAttempts[0].deadlineAt, new Date(Date.parse(attemptStartedAt) + 1_000).toISOString());
    assert.equal(parent.compositionAttempts[0].deadlineExpired, true);
    assert.equal(saves, 2);
  } finally {
    clearTimeout(timeout);
    releaseSave();
    await admission.catch(() => {});
  }
});

test('a cached completed child output waits for restored stored-principal grants before the successor can advance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-recovery-receipt-gap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const childActivity = counterActivity(directory, 'recovery.child-write');
  const nextActivity = counterActivity(directory, 'recovery.after-join');
  const f = await fixture(t, { workflowActivities: [childActivity, nextActivity] });
  const workload = await f.act('createWorkloadIdentity', { organizationId: f.organization.id, displayName: 'Recovery root' });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', { organizationId: f.organization.id, principal,
    scope: { kind: 'organization', organizationId: f.organization.id }, roles: ['member'] });
  const projectMembership = await f.act('createMembership', { organizationId: f.organization.id, principal,
    scope: { kind: 'project', projectId: f.project.id }, roles: ['contributor'] });
  await f.act('selectActiveContext', { context: { organizationId: f.organization.id, projectId: f.project.id } }, principal);
  const labelSchema = object({ label: text(80) }, ['label']);
  const child = await f.save({ id: 'recovery-cached-child', name: 'Cached child', projectId: f.project.id,
    runInputSchema: labelSchema, resultSchema: labelSchema,
    resultBindings: { label: { from: { kind: 'activity_output', nodeId: 'write', path: ['label'] } } },
    nodes: [{ id: 'write', name: 'Write child result', kind: 'action', activity: childActivity.descriptor.ref,
      bindings: { label: { from: { kind: 'run_input', path: ['label'] } } } }], edges: [],
  });
  const parent = await f.save({ id: 'recovery-cached-parent', name: 'Cached parent', projectId: f.project.id,
    nodes: [
      { id: 'compose', name: 'Join child', kind: 'child', workflow: { id: child.id, version: child.version },
        inputBindings: { label: { literal: 'child-once' } }, outputSchema: labelSchema,
        outputBindings: { label: { from: ['label'] } } },
      { id: 'review', name: 'Review the joined result', kind: 'human', humanTask: {
        outcomes: [{ id: 'approved', label: 'Continue' }, { id: 'rejected', label: 'Stop' }],
        form: { fields: [{ id: 'note', label: 'Note', type: 'text', required: false, maxLength: 80 }] },
      } },
      { id: 'after', name: 'After join', kind: 'action', activity: nextActivity.descriptor.ref,
        bindings: { label: { literal: 'successor' } } },
    ], edges: [
      { from: 'compose', to: 'review', outcome: 'success' },
      { from: 'review', to: 'after', outcome: 'approved' },
      { from: 'review', to: 'after', outcome: 'rejected' },
    ],
  });
  const started = await f.start(parent, {}, principal);
  const gate = await waitFor(() => f.readRun(started.workflowRunId), run => run.status === 'waiting_gate', 'parent did not reach its post-composition gate');
  const beforeFixture = await f.readState();
  const run = beforeFixture.workflowRuns[started.workflowRunId];
  const composition = run.compositionAttempts.find(attempt => attempt.nodeId === 'compose');
  const childRunId = composition.slots[0].runId;
  assert.equal(composition.status, 'completed');
  assert.equal(run.activityOutputs.compose.status, 'completed');
  assert.equal(run.activityOutputs.compose.digest, composition.outputDigest);
  assert.equal(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8'))[childActivity.descriptor.ref.id], 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8'))[nextActivity.descriptor.ref.id], undefined);

  // Reconstruct the exact persisted window after the canonical child receipt and
  // mapped parent output exist, but before finishAutomated records the transition.
  // The output and child are real runtime receipts; only the graph cursor is set
  // back to the pre-transition point that a crash can leave durable.
  await f.close();
  const statePath = join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const owner = state.workflowRuns[started.workflowRunId];
  owner.flow.status = 'running'; owner.flow.resumeStatus = null; owner.flow.nodeId = 'compose'; owner.flow.instance = composition.instance;
  owner.status = 'running'; owner.attempt = { nodeId: 'compose', instance: composition.instance, status: 'ready',
    outputDigest: composition.outputDigest, effect: 'pure' };
  owner.flow.history = owner.flow.history.filter(entry => entry.instance !== composition.instance && entry.nodeId !== 'review');
  const membership = state.organizations.memberships.find(value => value.id === projectMembership.id);
  assert.ok(membership, 'the stored principal project grant is present in the persistence fixture');
  membership.state = 'suspended';
  await writeFile(statePath, JSON.stringify(state));
  await f.reopen();

  const blocked = await waitFor(() => f.readRun(started.workflowRunId), value => value.status === 'paused' || value.compositions?.[0]?.status === 'waiting_authority',
    'the cached completion did not hold when the stored root principal lost project execution');
  assert.equal(blocked.status, 'paused');
  assert.equal(blocked.compositions[0].status, 'waiting_authority');
  assert.equal(blocked.compositions[0].instance, composition.instance);
  assert.equal(blocked.compositions[0].slots[0].runId, childRunId);
  assert.equal(blocked.history.some(entry => entry.nodeId === 'compose' && entry.instance === composition.instance), false,
    'the cached result has not advanced the parent graph');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8')),
    { [childActivity.descriptor.ref.id]: 1 }, 'no child or successor dispatch occurs while root authority is suspended');

  await f.act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await assert.rejects(f.act('continueWorkflowRun', { workflowRunId: started.workflowRunId, instance: composition.instance }),
    /authorized|revoked|available/i, 'a controller lease cannot bypass the stored root principal grant');
  await f.act('updateMembership', { organizationId: f.organization.id, membershipId: projectMembership.id, state: 'active' });
  const restoredButHeld = await f.readRun(started.workflowRunId);
  assert.equal(restoredButHeld.status, 'paused', 'restoring a grant does not implicitly continue a held run');
  assert.equal(restoredButHeld.compositions[0].status, 'waiting_authority');
  assert.equal(restoredButHeld.instance, composition.instance);
  assert.equal(restoredButHeld.history.some(entry => entry.nodeId === 'compose' && entry.instance === composition.instance), false);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8')),
    { [childActivity.descriptor.ref.id]: 1 }, 'grant restoration alone does not advance the cached output or run its successor');
  await f.act('continueWorkflowRun', { workflowRunId: started.workflowRunId, instance: composition.instance });
  const resumedGate = await waitFor(() => f.readRun(started.workflowRunId), value => value.status === 'waiting_gate',
    'restored authority did not settle the cached output to the same review gate');
  assert.equal(resumedGate.compositions[0].slots[0].runId, childRunId);
  assert.equal(resumedGate.compositions[0].instance, composition.instance);
  assert.equal(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8'))[childActivity.descriptor.ref.id], 1,
    'the already completed child receipt is never dispatched again');

  const response = await f.act('submitWorkflowHumanResponse', { workflowRunId: started.workflowRunId, instance: resumedGate.instance, values: { note: 'continue' } });
  const review = await f.act('prepareWorkflowHumanReview', { workflowRunId: started.workflowRunId, instance: resumedGate.instance,
    responseId: response.id, outcomeId: 'approved', targetNodeId: 'after' });
  await f.act('decideWorkflowRun', { workflowRunId: started.workflowRunId, instance: resumedGate.instance,
    responseId: response.id, outcomeId: 'approved', reviewedMaterialDigest: review.materialDigest });
  const completed = await waitFor(() => f.readRun(started.workflowRunId), value => value.status === 'completed', 'authorized successor did not complete');
  const counts = JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8'));
  assert.deepEqual(counts, { [childActivity.descriptor.ref.id]: 1, [nextActivity.descriptor.ref.id]: 1 });
  assert.equal(completed.history.filter(entry => entry.nodeId === 'compose').length, 1);

  const cancelledStart = await f.start(parent, {}, principal);
  const cancelledGate = await waitFor(() => f.readRun(cancelledStart.workflowRunId), value => value.status === 'waiting_gate',
    'second parent run did not reach the post-composition gate');
  const cancelledState = await f.readState();
  const cancelledOwner = cancelledState.workflowRuns[cancelledStart.workflowRunId];
  const cancelledComposition = cancelledOwner.compositionAttempts.find(attempt => attempt.nodeId === 'compose');
  const cancelledChildId = cancelledComposition.slots[0].runId;
  assert.equal(cancelledComposition.status, 'completed');
  await f.close();
  const cancelledStatePath = join(f.directory, 'state.json');
  const secondState = JSON.parse(await readFile(cancelledStatePath, 'utf8'));
  const cancelledRoot = secondState.workflowRuns[cancelledStart.workflowRunId];
  cancelledRoot.flow.status = 'running'; cancelledRoot.flow.resumeStatus = null;
  cancelledRoot.flow.nodeId = 'compose'; cancelledRoot.flow.instance = cancelledComposition.instance;
  cancelledRoot.status = 'running'; cancelledRoot.attempt = { nodeId: 'compose', instance: cancelledComposition.instance,
    status: 'ready', outputDigest: cancelledComposition.outputDigest, effect: 'pure' };
  cancelledRoot.flow.history = cancelledRoot.flow.history.filter(entry => entry.instance !== cancelledComposition.instance && entry.nodeId !== 'review');
  secondState.organizations.memberships.find(value => value.id === projectMembership.id).state = 'suspended';
  await writeFile(cancelledStatePath, JSON.stringify(secondState));
  await f.reopen();
  const cancelledAuthorityHold = await waitFor(() => f.readRun(cancelledStart.workflowRunId),
    value => value.status === 'paused' && value.compositions?.[0]?.status === 'waiting_authority',
    'the second cached completion did not hold under suspended root authority');
  assert.equal(cancelledAuthorityHold.instance, cancelledComposition.instance);
  assert.equal(cancelledAuthorityHold.compositions[0].slots[0].runId, cancelledChildId);
  await f.act('claimWorkflowRun', { workflowRunId: cancelledStart.workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId: cancelledStart.workflowRunId });
  const cancelledFinal = await f.readRun(cancelledStart.workflowRunId);
  assert.equal(cancelledFinal.status, 'cancelled');
  assert.equal(cancelledFinal.compositions[0].status, 'cancelled');
  assert.equal(cancelledFinal.compositions[0].slots[0].runId, cancelledChildId);
  assert.equal(cancelledFinal.compositions[0].outputDigest, cancelledComposition.outputDigest,
    'the previously completed child output remains recorded as evidence');
  assert.equal(cancelledFinal.history.some(entry => entry.nodeId === 'compose' && entry.instance === cancelledComposition.instance), false,
    'cancellation while authority is held does not advance the cached result');
  assert.equal((await f.readRun(cancelledChildId)).status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'dispatch-counts.json'), 'utf8')),
    { [childActivity.descriptor.ref.id]: 2, [nextActivity.descriptor.ref.id]: 1 },
    'cancelling a held cached transition preserves the child receipt and does not dispatch a successor');
});
