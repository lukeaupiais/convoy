import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (maxLength = 200) => ({ type: 'string', maxLength });
const compositionDefaults = {
  maxDescendantRuns: 128,
  maxMapItems: 100,
  maxConcurrentChildren: 8,
  maxDeadlineMs: 604_800_000,
  maxActiveDescendantRuns: 32,
  maxActiveDescendantsPerRoot: 8,
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(read, predicate, message, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

function durableActivity(id, inputSchema, outputSchema) {
  return {
    ref: { id, revision: 1 }, inputSchema, outputSchema,
    resources: { location: 'integration', adapterId: 'compensation-acceptance' },
    effect: 'durable-effect', approval: { required: false }, cancellation: 'reconcile-after-dispatch',
    confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: id },
  };
}

function durableReceiptRegistration(directory, activity, { loseAcknowledgement = true } = {}) {
  const receiptPath = join(directory, `${activity.ref.id.replaceAll('.', '-')}-receipt.json`);
  const entered = [];
  const state = async () => JSON.parse(await readFile(receiptPath, 'utf8').catch(() => '{"dispatches":0,"applied":{},"receipts":{}}'));
  const save = value => import('node:fs/promises').then(({ writeFile }) => writeFile(receiptPath, JSON.stringify(value)));
  return {
    descriptor: activity,
    entered,
    async readState() { return state(); },
    implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, request: structuredClone(input) }; },
      async dispatch(_context, input, intent) {
        const current = await state();
        current.dispatches += 1;
        const key = intent.requestKey;
        if (!current.receipts[key]) {
          current.applied[key] = true;
          current.receipts[key] = { receiptId: `${activity.ref.id}:${input.recordId}`, recordId: input.recordId };
        }
        await save(current);
        entered.push({ key, input: structuredClone(input) });
        if (loseAcknowledgement) throw new Error('Adapter applied the operation but lost its acknowledgement.');
        return { state: 'completed', output: structuredClone(current.receipts[key]) };
      },
      async confirm() { return { state: 'waiting' }; },
      async reconcile(_context, _input, intent, request) {
        const current = await state();
        const key = intent.requestKey;
        if (request?.requestedResolution === 'applied' && current.receipts[key])
          return { state: 'applied', output: structuredClone(current.receipts[key]) };
        if (request?.requestedResolution === 'not_applied' && !current.receipts[key]) return { state: 'not_applied' };
        return { state: 'unknown', message: 'No matching adapter receipt exists.' };
      },
    },
  };
}

function actionNode(id, activityId, bindings = {}) {
  return { id, name: id, kind: 'action', activity: { id: activityId, revision: 1 }, bindings };
}

async function fixture(t, workflowActivities, clock) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-compensation-'));
  const client = 'workflow-composition-compensation-acceptance';
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Compensation acceptance must not invoke a provider.'); },
    runners: { execute: async () => assert.fail('Integration compensation must not acquire a runner.'), close: async () => {} },
    workflowActivities,
    ...(clock ? { clock } : {}),
  };
  let runtime = await createRuntime(options);
  const beforeClose = [];
  t.after(async () => {
    for (const cleanup of beforeClose) await cleanup();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const organization = await act('createOrganization', {
    slug: `workflow-compensation-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Workflow compensation acceptance', kind: 'team',
  });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Compensation review' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  return {
    client, directory, organization, project, options, act,
    beforeClose(fn) { beforeClose.push(fn); },
    async save(workflow) { return act('saveWorkflow', { projectId: project.id, workflow }); },
    async run(workflow, runInput = {}) {
      return act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: workflow.version, runInput });
    },
    readRun(workflowRunId) { return act('getWorkflowRun', { workflowRunId }); },
    async readState() { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); },
    async restart() {
      await runtime.close();
      runtime = await createRuntime(options);
    },
  };
}

function activityWorkflow({ id, projectId, activityId, inputSchema, outputSchema, bindings, input = {} }) {
  return {
    id, name: id, projectId,
    runInputSchema: inputSchema,
    resultSchema: outputSchema,
    resultBindings: Object.fromEntries(Object.keys(outputSchema.properties).map(key => [key,
      { from: { kind: 'activity_output', nodeId: 'run', path: [key] } }])),
    nodes: [actionNode('run', activityId, bindings ?? Object.fromEntries(Object.keys(input).map(key => [key, { from: { kind: 'run_input', path: [key] } }])) )],
    edges: [],
  };
}

test('declared failure compensation runs its exact child without changing the failed forward outcome', async t => {
  const calls = [];
  const forwardInput = object({ recordId: string(80) }, ['recordId']);
  const forwardOutput = object({ receiptId: string(160) }, ['receiptId']);
  const compensationInput = object({ recordId: string(80), reason: string(80) }, ['recordId', 'reason']);
  const compensationOutput = object({ compensationId: string(160) }, ['compensationId']);
  const forward = durableActivity('inventory.reserve-record', forwardInput, forwardOutput);
  const compensation = durableActivity('inventory.release-record', compensationInput, compensationOutput);
  const f = await fixture(t, [
    { descriptor: forward, implementation: {
      async prepare(input, identity) { return { key: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input) {
        calls.push({ operation: 'forward', input: structuredClone(input) });
        return { state: 'failed', message: 'The reserve was rejected before application.' };
      },
      async confirm() { return { state: 'failed', message: 'Not applied.' }; },
      async reconcile() { return { state: 'not_applied', message: 'The reserve was not applied.' }; },
    } },
    { descriptor: compensation, implementation: {
      async prepare(input, identity) { return { key: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input) {
        calls.push({ operation: 'failure-compensation', input: structuredClone(input) });
        return { state: 'completed', output: { compensationId: `release:${input.recordId}` } };
      },
      async confirm() { return { state: 'waiting' }; },
      async reconcile() { return { state: 'unknown' }; },
    } },
  ]);

  const forwardWorkflow = await f.save(activityWorkflow({ id: 'reserve-record-v1', projectId: f.project.id,
    activityId: forward.ref.id, inputSchema: forwardInput, outputSchema: forwardOutput,
    input: { recordId: 'lot-17' } }));
  const compensationWorkflow = await f.save(activityWorkflow({ id: 'release-record-v1', projectId: f.project.id,
    activityId: compensation.ref.id, inputSchema: compensationInput, outputSchema: compensationOutput,
    input: { recordId: 'lot-17', reason: 'reserve failed' } }));
  const parent = await f.save({
    id: 'reserve-with-release', name: 'Reserve with explicit failure release', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']),
    nodes: [{ id: 'reserve', name: 'Reserve inventory', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version }, inputBindings: {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
      }, outputSchema: object({ receiptId: string(160) }, ['receiptId']), outputBindings: {
        receiptId: { from: ['receiptId'] },
      }, compensations: [
        { id: 'release-on-failure', trigger: 'failure',
          workflow: { id: compensationWorkflow.id, version: compensationWorkflow.version }, inputBindings: {
            recordId: { from: { kind: 'run_input', path: ['recordId'] } },
            reason: { literal: 'reserve failed' },
          } },
        { id: 'release-on-cancel', trigger: 'cancelled',
          workflow: { id: compensationWorkflow.id, version: compensationWorkflow.version }, inputBindings: {
            recordId: { from: { kind: 'run_input', path: ['recordId'] } },
            reason: { literal: 'parent cancelled' },
          } },
      ] }],
    edges: [],
  });

  const { workflowRunId } = await f.run(parent, { recordId: 'lot-17' });
  const failureCompensation = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    slot => slot.childRunCreated, 'declared failure compensation child was not admitted');
  const failureCompensationRun = await waitFor(() => f.readRun(failureCompensation.runId),
    run => ['completed', 'failed', 'cancelled', 'interrupted', 'paused'].includes(run.status),
    'declared failure compensation child did not reach a readback state');
  assert.equal(failureCompensationRun.status, 'completed', JSON.stringify(failureCompensationRun));
  assert.equal(calls.length, 2);
  const finished = await f.readRun(workflowRunId);
  assert.equal(finished.status, 'failed', 'compensation must preserve the original forward failure');
  assert.deepEqual(calls.map(call => call.operation), ['forward', 'failure-compensation']);
  assert.deepEqual(calls[1].input, { recordId: 'lot-17', reason: 'reserve failed' });
  const stored = (await f.readState()).workflowRuns[workflowRunId];
  assert.ok(stored.compositionAttempts?.length, 'the forward composition remains canonical owner history');
  assert.equal(stored.compositionAttempts[0].status, 'failed');
  assert.equal(stored.compositionAttempts[0].compensations?.[0]?.workflow?.version, compensationWorkflow.version);
  assert.equal(stored.compositionAttempts[0].compensations?.[1]?.status, 'queued', 'the unrelated cancellation trigger does not run for forward failure');
  assert.equal(stored.workflowRuns?.[stored.compositionAttempts[0].compensations[1].runId], undefined);
  assert.equal(Object.keys((await f.readState()).sessions ?? {}).length, 0);
});

test('cancellation compensation waits for exact forward reconciliation and its own uncertain receipt survives restart', async t => {
  const forwardInput = object({ recordId: string(80) }, ['recordId']);
  const compensationInput = object({ recordId: string(80), reason: string(80) }, ['recordId', 'reason']);
  const outputSchema = object({ receiptId: string(160), recordId: string(80) }, ['receiptId', 'recordId']);
  const forward = durableActivity('inventory.apply-forward', forwardInput, outputSchema);
  const compensation = durableActivity('inventory.apply-compensation', compensationInput, outputSchema);
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-compensation-receipts-'));
  const forwardAdapter = durableReceiptRegistration(directory, forward);
  const compensationAdapter = durableReceiptRegistration(directory, compensation);
  const f = await fixture(t, [forwardAdapter, compensationAdapter]);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const forwardWorkflow = await f.save(activityWorkflow({ id: 'forward-v1', projectId: f.project.id,
    activityId: forward.ref.id, inputSchema: forwardInput, outputSchema, input: { recordId: 'doc-44' } }));
  const compensationWorkflow = await f.save(activityWorkflow({ id: 'cancel-compensation-v1', projectId: f.project.id,
    activityId: compensation.ref.id, inputSchema: compensationInput, outputSchema,
    input: { recordId: 'doc-44', reason: 'parent cancelled' } }));
  const parent = await f.save({
    id: 'forward-with-cancel-compensation', name: 'Forward with explicit cancellation compensation', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']),
    nodes: [{ id: 'forward', name: 'Apply forward operation', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version }, inputBindings: {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
      }, outputSchema, outputBindings: {
        receiptId: { from: ['receiptId'] }, recordId: { from: ['recordId'] },
      }, compensations: [{ id: 'undo-on-cancel', trigger: 'cancelled',
        workflow: { id: compensationWorkflow.id, version: compensationWorkflow.version }, inputBindings: {
          recordId: { from: { kind: 'run_input', path: ['recordId'] } }, reason: { literal: 'parent cancelled' },
        } }] }],
    edges: [],
  });
  const { workflowRunId } = await f.run(parent, { recordId: 'doc-44' });
  const parentStarted = await waitFor(() => f.readRun(workflowRunId), run => run.compositions?.[0]?.slots?.[0]?.runId,
    'forward child run was not reserved');
  const forwardRunId = parentStarted.compositions[0].slots[0].runId;
  const uncertainForward = await waitFor(() => f.readRun(forwardRunId), run => run.attempt?.status === 'uncertain',
    'forward operation did not retain its lost acknowledgement');
  const forwardInstance = uncertainForward.instance;
  const forwardEffectKey = uncertainForward.attempt.effectKey;
  assert.ok(forwardEffectKey);
  assert.equal((await forwardAdapter.readState()).dispatches, 1);

  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  assert.equal((await f.readRun(workflowRunId)).status, 'cancelled');
  assert.equal((await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0].status, 'queued',
    'the pre-reserved compensation slot must remain queued while the forward effect is uncertain');
  await f.restart();
  const afterRestartForward = await f.readRun(forwardRunId);
  assert.equal(afterRestartForward.attempt.status, 'uncertain');
  assert.equal(afterRestartForward.instance, forwardInstance);
  await f.act('claimWorkflowRun', { workflowRunId: forwardRunId });
  await f.act('reconcileWorkflowRun', { workflowRunId: forwardRunId, instance: forwardInstance,
    effectKey: forwardEffectKey, resolution: 'applied' });

  const compensationSlot = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    slot => slot.childRunCreated,
    'settled cancelled forward did not reserve its declared compensation child');
  const compensationRunId = compensationSlot.runId;
  const uncertainCompensation = await waitFor(() => f.readRun(compensationRunId), run => run.attempt?.status === 'uncertain',
    'compensation operation did not retain its lost acknowledgement');
  const compensationInstance = uncertainCompensation.instance;
  const compensationEffectKey = uncertainCompensation.attempt.effectKey;
  assert.ok(compensationEffectKey);
  assert.equal((await compensationAdapter.readState()).dispatches, 1);
  assert.equal((await f.readRun(workflowRunId)).status, 'cancelled', 'compensation cannot change the parent cancellation outcome');

  await f.restart();
  const recoveredCompensation = await f.readRun(compensationRunId);
  assert.equal(recoveredCompensation.attempt.status, 'uncertain');
  assert.equal(recoveredCompensation.instance, compensationInstance);
  await f.act('claimWorkflowRun', { workflowRunId: compensationRunId });
  await f.act('reconcileWorkflowRun', { workflowRunId: compensationRunId, instance: compensationInstance,
    effectKey: compensationEffectKey, resolution: 'applied' });
  const settled = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    value => value.status === 'completed', 'exact compensation receipt did not settle after restart');
  assert.equal(settled.status, 'completed');
  assert.equal((await f.readRun(workflowRunId)).status, 'cancelled', 'the compensation does not advance or change the cancelled parent');
  assert.equal((await forwardAdapter.readState()).dispatches, 1, 'forward recovery never replays the applied operation');
  assert.equal((await compensationAdapter.readState()).dispatches, 1, 'compensation recovery never replays the applied operation');
  const stored = await f.readState();
  assert.equal(stored.workflowRuns[workflowRunId].compositionAttempts[0].compensations[0].workflow.version, compensationWorkflow.version);
  assert.equal(stored.workflowRuns[workflowRunId].compositionAttempts[0].compensations[0].runId, compensationRunId);
});

test('a required compensation approval waits for current human material and never auto-approves', async t => {
  const calls = [];
  const forwardInput = object({ recordId: string(80) }, ['recordId']);
  const outputSchema = object({ receiptId: string(160), recordId: string(80) }, ['receiptId', 'recordId']);
  const forward = durableActivity('inventory.reject-forward', forwardInput, outputSchema);
  const releaseInput = object({ recordId: string(80), reason: string(120) }, ['recordId', 'reason']);
  const release = { ...durableActivity('inventory.approved-release', releaseInput, outputSchema),
    approval: { required: true, policy: 'workflow-gate' } };
  const f = await fixture(t, [
    { descriptor: forward, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch() { calls.push('forward'); return { state: 'failed', message: 'The forward operation was rejected.' }; },
      async confirm() { return { state: 'failed' }; }, async reconcile() { return { state: 'not_applied' }; },
    } },
    { descriptor: release, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input) {
        calls.push({ operation: 'release', input: structuredClone(input) });
        return { state: 'completed', output: { receiptId: `release:${input.recordId}`, recordId: input.recordId } };
      },
      async confirm() { return { state: 'waiting' }; }, async reconcile() { return { state: 'unknown' }; },
    } },
  ]);
  const forwardWorkflow = await f.save(activityWorkflow({ id: 'approval-forward-child', projectId: f.project.id,
    activityId: forward.ref.id, inputSchema: forwardInput, outputSchema, input: { recordId: 'batch-12' } }));
  const releaseWorkflow = await f.save({
    id: 'reviewed-release-child', name: 'Reviewed release child', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']), resultSchema: outputSchema,
    resultBindings: {
      receiptId: { from: { kind: 'activity_output', nodeId: 'release', path: ['receiptId'] } },
      recordId: { from: { kind: 'activity_output', nodeId: 'release', path: ['recordId'] } },
    },
    nodes: [
      { id: 'review', name: 'Authorize release', kind: 'human', prompt: 'Review the exact release request.', humanTask: {
        outcomes: [
          { id: 'authorize_release', label: 'Authorize release', effect: 'approve_activity' },
          { id: 'leave_unreleased', label: 'Leave unreleased' },
        ],
        form: { fields: [{ id: 'reason', label: 'Release reason', type: 'text', required: true, minLength: 3, maxLength: 120 }] },
      } },
      actionNode('release', release.ref.id, {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
        reason: { from: { kind: 'human_response', nodeId: 'review', path: ['reason'] } },
      }),
    ],
    edges: [{ from: 'review', to: 'release', outcome: 'authorize_release' }],
  });
  const parent = await f.save({
    id: 'reviewed-forward-release', name: 'Forward with reviewed failure compensation', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']),
    nodes: [{ id: 'forward', name: 'Apply forward operation', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version }, inputBindings: {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
      }, outputSchema, outputBindings: {
        receiptId: { from: ['receiptId'] }, recordId: { from: ['recordId'] },
      }, compensations: [{ id: 'reviewed-release', trigger: 'failure',
        workflow: { id: releaseWorkflow.id, version: releaseWorkflow.version }, inputBindings: {
          recordId: { from: { kind: 'run_input', path: ['recordId'] } },
        } }] }],
    edges: [],
  });

  const { workflowRunId } = await f.run(parent, { recordId: 'batch-12' });
  const compensationSlot = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    slot => slot.childRunCreated,
    'failure compensation child was not reserved');
  const compensationRunId = compensationSlot.runId;
  let gate = await f.readRun(compensationRunId);
  assert.equal(gate.status, 'waiting_gate');
  assert.equal(calls.length, 1, 'only the rejected forward dispatch has run before human approval');
  const revisedCompensationWorkflow = await f.save({
    id: releaseWorkflow.id, name: 'Reviewed release child v2', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']), resultSchema: outputSchema,
    resultBindings: {
      receiptId: { from: { kind: 'activity_output', nodeId: 'release', path: ['receiptId'] } },
      recordId: { from: { kind: 'activity_output', nodeId: 'release', path: ['recordId'] } },
    },
    nodes: [
      { id: 'review', name: 'Authorize release v2', kind: 'human', prompt: 'Review the exact release request.', humanTask: {
        outcomes: [
          { id: 'authorize_release', label: 'Authorize release', effect: 'approve_activity' },
          { id: 'leave_unreleased', label: 'Leave unreleased' },
        ],
        form: { fields: [{ id: 'reason', label: 'Release reason', type: 'text', required: true, minLength: 3, maxLength: 120 }] },
      } },
      actionNode('release', release.ref.id, {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
        reason: { from: { kind: 'human_response', nodeId: 'review', path: ['reason'] } },
      }),
    ],
    edges: [{ from: 'review', to: 'release', outcome: 'authorize_release' }],
  });
  assert.equal(revisedCompensationWorkflow.version, releaseWorkflow.version + 1);
  await f.restart();
  gate = await f.readRun(compensationRunId);
  assert.equal(gate.workflowVersion, releaseWorkflow.version, 'the compensation run retains its exact child workflow pin after publication and restart');
  await f.act('claimWorkflowRun', { workflowRunId: compensationRunId });
  const response = await f.act('submitWorkflowHumanResponse', { workflowRunId: compensationRunId,
    instance: gate.instance, values: { reason: 'No inventory was reserved.' } });
  const review = await f.act('prepareWorkflowHumanReview', { workflowRunId: compensationRunId,
    instance: gate.instance, responseId: response.id, outcomeId: 'authorize_release', targetNodeId: 'release' });
  assert.equal(calls.length, 1, 'submission and prepared review cannot dispatch the compensation effect');
  assert.deepEqual(review.reservation.preview.input, { recordId: 'batch-12', reason: 'No inventory was reserved.' });
  await f.act('decideWorkflowRun', { workflowRunId: compensationRunId, instance: gate.instance,
    outcomeId: 'authorize_release', responseId: response.id, reviewedMaterialDigest: review.materialDigest,
    activityReservationId: review.reservation.id, activityReservationDigest: review.reservation.digest });

  const completed = await waitFor(() => f.readRun(compensationRunId), run => run.status === 'completed',
    'approved compensation child did not complete');
  const parentAfter = await f.readRun(workflowRunId);
  assert.equal(parentAfter.status, 'failed', 'the compensation receipt does not erase the failed forward outcome');
  assert.equal(parentAfter.compositions[0].status, 'failed');
  assert.equal(completed.attempt.status, 'completed');
  assert.deepEqual(calls, ['forward', { operation: 'release', input: { recordId: 'batch-12', reason: 'No inventory was reserved.' } }]);
});

test('a tightened current root budget blocks compensation dispatch after the forward receipt settles', async t => {
  const releaseFailure = deferred();
  let didEnter = false;
  let compensationDispatches = 0;
  const forwardInput = object({ recordId: string(80) }, ['recordId']);
  const outputSchema = object({ receiptId: string(160), recordId: string(80) }, ['receiptId', 'recordId']);
  const forward = durableActivity('records.fail-before-apply', forwardInput, outputSchema);
  const compensationInput = object({ recordId: string(80) }, ['recordId']);
  const compensation = durableActivity('records.compensate-failure', compensationInput, outputSchema);
  const f = await fixture(t, [
    { descriptor: forward, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch() { didEnter = true; await releaseFailure.promise; return { state: 'failed', message: 'The forward operation was not applied.' }; },
      async confirm() { return { state: 'failed' }; }, async reconcile() { return { state: 'not_applied' }; },
    } },
    { descriptor: compensation, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input) {
        compensationDispatches += 1;
        return { state: 'completed', output: { receiptId: `comp:${input.recordId}`, recordId: input.recordId } };
      },
      async confirm() { return { state: 'waiting' }; }, async reconcile() { return { state: 'unknown' }; },
    } },
  ]);
  f.beforeClose(() => releaseFailure.resolve());
  const forwardWorkflow = await f.save(activityWorkflow({ id: 'bounded-forward-child', projectId: f.project.id,
    activityId: forward.ref.id, inputSchema: forwardInput, outputSchema, input: { recordId: 'case-9' } }));
  const compensationWorkflow = await f.save(activityWorkflow({ id: 'bounded-compensation-child', projectId: f.project.id,
    activityId: compensation.ref.id, inputSchema: compensationInput, outputSchema, input: { recordId: 'case-9' } }));
  const parent = await f.save({
    id: 'budgeted-compensation', name: 'Budgeted compensation', projectId: f.project.id,
    runInputSchema: object({ recordId: string(80) }, ['recordId']),
    nodes: [{ id: 'forward', name: 'Forward action', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version }, inputBindings: {
        recordId: { from: { kind: 'run_input', path: ['recordId'] } },
      }, outputSchema, outputBindings: { receiptId: { from: ['receiptId'] }, recordId: { from: ['recordId'] } },
      compensations: [{ id: 'failure-compensation', trigger: 'failure',
        workflow: { id: compensationWorkflow.id, version: compensationWorkflow.version }, inputBindings: {
          recordId: { from: { kind: 'run_input', path: ['recordId'] } },
        } }] }],
    edges: [],
  });
  const { workflowRunId } = await f.run(parent, { recordId: 'case-9' });
  await waitFor(async () => didEnter, Boolean, 'forward operation did not reach its barrier');
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id, baseRevision: 0,
    limits: { ...compositionDefaults, maxDescendantRuns: 1 },
  });
  releaseFailure.resolve();
  const settled = await waitFor(() => f.readRun(workflowRunId), run => run.status === 'failed',
    'failed forward did not retain its failed outcome under a reduced budget');
  assert.equal(compensationDispatches, 0, 'lowering the current root ceiling prevents new compensation work from dispatching');
  assert.equal(settled.status, 'failed');
  const stored = await f.readState();
  const compensationSlot = stored.workflowRuns[workflowRunId].compositionAttempts[0].compensations[0];
  assert.notEqual(compensationSlot.status, 'completed');
  assert.equal(compensationSlot.childRunCreated, false, 'a tightened descendant budget blocks admission as well as adapter dispatch');
  assert.equal(stored.workflowRuns[compensationSlot.runId], undefined, 'the pre-reserved ID is not materialized as a child run under the reduced ceiling');
  assert.equal(stored.workflowRuns[workflowRunId].compositionBudget.reservedDescendantRuns, 2,
    'the forward and declared compensation reservations remain accounted after policy reduction');
  const reservedCompensationId = compensationSlot.runId;
  await f.restart();
  const recovered = await f.readState();
  const recoveredSlot = recovered.workflowRuns[workflowRunId].compositionAttempts[0].compensations[0];
  assert.equal(recoveredSlot.runId, reservedCompensationId, 'restart preserves the pre-reserved compensation identity');
  assert.equal(recoveredSlot.childRunCreated, false, 'restart does not admit compensation under the still-reduced ceiling');
  assert.equal(recovered.workflowRuns[workflowRunId].compositionBudget.reservedDescendantRuns, 2,
    'restart does not shrink the canonical descendant reservation count');
});

test('compensation deadline tightening is relative to its own admission and exact cleanup never replays it', async t => {
  let currentTime = Date.now();
  const forwardInput = object({ recordId: string(80) }, ['recordId']);
  const outputSchema = object({ receiptId: string(160), recordId: string(80) }, ['receiptId', 'recordId']);
  const forward = durableActivity('records.fail-before-release', forwardInput, outputSchema);
  const compensation = durableActivity('records.release-with-lost-ack', forwardInput, outputSchema);
  let forwardCalls = 0;
  let compensationCalls = 0;
  const receipts = new Map();
  const f = await fixture(t, [
    { descriptor: forward, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input) {
        forwardCalls += 1;
        currentTime += 500;
        return { state: 'failed', message: 'The forward operation was not applied.' };
      },
      async confirm() { return { state: 'failed' }; }, async reconcile() { return { state: 'not_applied' }; },
    } },
    { descriptor: compensation, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, ...input }; },
      async dispatch(_context, input, intent) {
        compensationCalls += 1;
        receipts.set(intent.requestKey, { receiptId: `release:${input.recordId}`, recordId: input.recordId });
        throw new Error('The release applied, but the acknowledgement was lost.');
      },
      async confirm() { return { state: 'waiting' }; },
      async reconcile(_context, _input, intent, request) {
        const receipt = receipts.get(intent.requestKey);
        return request?.requestedResolution === 'applied' && receipt
          ? { state: 'applied', output: structuredClone(receipt) }
          : { state: 'unknown' };
      },
    } },
  ], () => currentTime);
  const forwardWorkflow = await f.save(activityWorkflow({ id: 'deadline-forward-child', projectId: f.project.id,
    activityId: forward.ref.id, inputSchema: forwardInput, outputSchema, input: { recordId: 'lot-55' } }));
  const compensationWorkflow = await f.save(activityWorkflow({ id: 'deadline-compensation-child', projectId: f.project.id,
    activityId: compensation.ref.id, inputSchema: forwardInput, outputSchema, input: { recordId: 'lot-55' } }));
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id, baseRevision: 0,
    limits: { ...compositionDefaults, maxDeadlineMs: 60_000 },
  });
  const parent = await f.save({
    id: 'deadline-compensation-parent', name: 'Tighten the admitted compensation deadline', projectId: f.project.id,
    runInputSchema: forwardInput,
    nodes: [{ id: 'forward', name: 'Forward operation', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version },
      inputBindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } },
      outputSchema, outputBindings: { receiptId: { from: ['receiptId'] }, recordId: { from: ['recordId'] } },
      compensations: [{ id: 'release-after-failure', trigger: 'failure',
        workflow: { id: compensationWorkflow.id, version: compensationWorkflow.version },
        inputBindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } } }],
    }], edges: [],
  });
  const { workflowRunId } = await f.run(parent, { recordId: 'lot-55' });
  const compensationSlot = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    slot => slot.childRunCreated, 'the declared compensation child was not admitted');
  const compensationRun = await waitFor(() => f.readRun(compensationSlot.runId),
    run => run.attempt?.status === 'uncertain', 'compensation did not retain the real lost acknowledgement');
  assert.equal(forwardCalls, 1);
  assert.equal(compensationCalls, 1);
  const beforeReduction = (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0];
  assert.ok(beforeReduction.startedAt, 'the compensation reservation records its own admission time');
  const compensationInstance = beforeReduction.instance;
  const compensationEffectKey = compensationRun.attempt.effectKey;
  const compositionStart = (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].startedAt;
  assert.ok(Date.parse(beforeReduction.startedAt) > Date.parse(compositionStart),
    'the compensation starts after, and has a distinct clock origin from, the forward composition');

  currentTime += 2_000;
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id, baseRevision: 1,
    limits: { ...compositionDefaults, maxDeadlineMs: 1_000 },
  });
  const afterReduction = (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0];
  assert.equal(Date.parse(afterReduction.deadlineAt), Date.parse(beforeReduction.startedAt) + 1_000,
    'current policy tightens this compensation from its own start, not the older parent start');
  assert.ok(Date.parse(afterReduction.deadlineAt) < currentTime);

  await f.act('claimWorkflowRun', { workflowRunId: compensationRun.id });
  await f.act('reconcileWorkflowRun', { workflowRunId: compensationRun.id, instance: compensationInstance,
    effectKey: compensationEffectKey, resolution: 'applied' });
  const settled = await waitFor(async () => (await f.readState()).workflowRuns[workflowRunId].compositionAttempts[0].compensations[0],
    slot => ['completed', 'failed'].includes(slot.status), 'expired compensation did not settle its exact receipt');
  assert.equal(settled.runId, compensationRun.id);
  assert.equal(settled.instance, compensationInstance);
  assert.equal((await f.readRun(workflowRunId)).status, 'failed', 'compensation cannot rewrite the original forward failure');
  assert.equal(forwardCalls, 1);
  assert.equal(compensationCalls, 1, 'late policy cleanup cannot redispatch the compensation effect');
});

test('a compensation cannot pin a child workflow owned by another project', async t => {
  const f = await fixture(t, []);
  const summarySchema = object({ summary: string(120) }, ['summary']);
  const reviewNode = (id = 'review') => ({ id, name: 'Review', kind: 'human', prompt: 'Review this project work.',
    humanTask: { outcomes: [
      { id: 'complete', label: 'Complete review' }, { id: 'decline', label: 'Decline review' },
    ], form: { fields: [{ id: 'summary', label: 'Review summary', type: 'text', required: true, minLength: 3, maxLength: 120 }] } } });
  const otherProject = await f.act('saveProject', { organizationId: f.organization.id, name: 'Publication review' });
  await f.act('selectActiveContext', { context: { organizationId: f.organization.id, projectId: otherProject.id } });
  const foreignChild = await f.act('saveWorkflow', {
    projectId: otherProject.id,
    workflow: { id: 'foreign-project-compensation', name: 'Foreign project compensation', projectId: otherProject.id,
      resultSchema: summarySchema,
      resultBindingsByTerminal: { review: { summary: { from: { kind: 'human_response', nodeId: 'review', path: ['summary'] } } } },
      nodes: [reviewNode()], edges: [] },
  });
  await f.act('selectActiveContext', { context: { organizationId: f.organization.id, projectId: f.project.id } });
  const forwardChild = await f.save({
    id: 'local-forward-before-foreign-compensation', name: 'Local forward child', projectId: f.project.id,
    resultSchema: summarySchema,
    resultBindingsByTerminal: { review: { summary: { from: { kind: 'human_response', nodeId: 'review', path: ['summary'] } } } },
    nodes: [reviewNode()], edges: [],
  });
  const parent = {
    id: 'foreign-compensation-parent', name: 'Reject foreign compensation pin', projectId: f.project.id,
    nodes: [{ id: 'forward', name: 'Forward', kind: 'child',
      workflow: { id: forwardChild.id, version: forwardChild.version }, inputBindings: {},
      outputSchema: summarySchema, outputBindings: { summary: { from: ['summary'] } },
      compensations: [{ id: 'foreign-release', trigger: 'failure',
        workflow: { id: foreignChild.id, version: foreignChild.version }, inputBindings: {} }],
    }], edges: [],
  };
  await assert.rejects(
    f.save(parent),
    /project|scope|available|authorized|same/i,
    'publication rejects a compensation pin that crosses the owning project boundary',
  );
  assert.equal(Object.keys((await f.readState()).workflowRuns ?? {}).length, 0,
    'a rejected cross-project child pin allocates no run or compensation reservation');
});
