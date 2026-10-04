import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 80 };

async function waitFor(read, predicate, message) {
  const deadline = Date.now() + 7000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

test('cancel during committed failure compensation preserves its trigger and exact unknown receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-cancelled-compensation-'));
  const forwardInput = object({ recordId: text });
  const compensationInput = object({ recordId: text, reason: text });
  const outputSchema = object({ receiptId: text, recordId: text });
  let compensationDispatches = 0;
  let reconciled = false;
  const descriptor = (id, inputSchema) => ({ ref: { id, revision: 1 }, inputSchema, outputSchema,
    resources: { location: 'integration', adapterId: 'cancelled-compensation-test' }, effect: 'durable-effect',
    approval: { required: false }, cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed',
    reconciliation: 'adapter', presentation: { label: id } });
  const forward = descriptor('records.forward-fails', forwardInput);
  const failureCompensation = descriptor('records.failure-compensation', compensationInput);
  const cancelCompensation = descriptor('records.cancel-compensation', compensationInput);
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Integration compensation must not allocate a provider session.'); },
    runners: { execute: async () => assert.fail('Integration compensation must not allocate a runner.'), close: async () => {} },
    workflowActivities: [
      { descriptor: forward, implementation: {
        async prepare(input) { return { recordId: input.recordId }; },
        async dispatch() { return { state: 'failed', message: 'Forward operation was rejected.' }; },
        async confirm() { return { state: 'not_applied' }; },
        async reconcile() { return { state: 'not_applied' }; },
      } },
      ...[[failureCompensation, 'failure'], [cancelCompensation, 'cancel']].map(([value, role]) => ({ descriptor: value, implementation: {
        async prepare(input) { return structuredClone(input); },
        async dispatch() {
          if (role === 'cancel') assert.fail('A new cancellation trigger must not replace an already committed failure trigger.');
          compensationDispatches++;
          throw new Error('Compensation may have applied before acknowledgement loss.');
        },
        async confirm() { return { state: 'waiting' }; },
        async reconcile() {
          return reconciled ? { state: 'applied', output: { receiptId: 'compensation-1', recordId: 'record-9' } } : { state: 'unknown' };
        },
      } }))],
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, fields = {}) => runtime.command({ action, client: 'composition-cancelled-compensation', ...fields });
  const project = await act('saveProject', { name: 'Cancellation during compensation' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  const save = workflow => act('saveWorkflow', { projectId: project.id, workflow });
  const child = async (id, name, activity, inputSchema) => save({ id, name, projectId: project.id,
    runInputSchema: inputSchema,
    resultSchema: outputSchema,
    resultBindings: {
      receiptId: { from: { kind: 'activity_output', nodeId: 'apply', path: ['receiptId'] } },
      recordId: { from: { kind: 'activity_output', nodeId: 'apply', path: ['recordId'] } },
    },
    nodes: [{ id: 'apply', name, kind: 'action', activity: activity.ref,
      bindings: Object.fromEntries(Object.keys(inputSchema.properties).map(key => [key, { from: { kind: 'run_input', path: [key] } }])) }], edges: [],
  });
  const forwardWorkflow = await child('forward-failure-child', 'Apply forward operation', forward, forwardInput);
  const failureWorkflow = await child('failure-compensation-child', 'Compensate failure', failureCompensation, compensationInput);
  const cancelWorkflow = await child('cancel-compensation-child', 'Compensate cancellation', cancelCompensation, compensationInput);
  const parent = await save({ id: 'forward-with-two-outcomes', name: 'Forward with outcome-specific compensation', projectId: project.id,
    nodes: [{ id: 'forward', name: 'Run forward operation', kind: 'child',
      workflow: { id: forwardWorkflow.id, version: forwardWorkflow.version }, inputBindings: { recordId: { literal: 'record-9' } },
      outputSchema, outputBindings: {
        receiptId: { from: ['receiptId'] }, recordId: { from: ['recordId'] },
      }, compensations: [
        { id: 'failure-route', trigger: 'failure', workflow: { id: failureWorkflow.id, version: failureWorkflow.version }, inputBindings: {
          recordId: { literal: 'record-9' }, reason: { literal: 'forward failed' },
        } },
        { id: 'cancel-route', trigger: 'cancelled', workflow: { id: cancelWorkflow.id, version: cancelWorkflow.version }, inputBindings: {
          recordId: { literal: 'record-9' }, reason: { literal: 'operator cancelled' },
        } },
      ] }], edges: [] });
  const started = await act('startWorkflowRun', { projectId: project.id, workflowId: parent.id, workflowVersion: parent.version });
  await waitFor(() => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    value => value.status === 'failed' && value.compositions?.[0]?.compensations?.some(slot => slot.id === 'failure-route' && slot.status === 'uncertain'),
    'failure compensation did not reach an uncertain receipt');
  const beforeCancel = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).workflowRuns[started.workflowRunId];
  const attempt = beforeCancel.compositionAttempts[0];
  const failureSlot = attempt.compensations.find(slot => slot.id === 'failure-route');
  const cancelSlot = attempt.compensations.find(slot => slot.id === 'cancel-route');
  const forwardOutcome = structuredClone(attempt.forwardOutcome);
  const compensationRunBefore = await act('getWorkflowRun', { workflowRunId: failureSlot.runId });
  const compensationInstance = compensationRunBefore.instance;
  const compensationEffectKey = compensationRunBefore.attempt.effectKey;
  assert.ok(compensationEffectKey);
  assert.equal(failureSlot.effectKey, compensationEffectKey);
  assert.equal(attempt.forwardOutcome.trigger, 'failure');
  assert.equal(compensationDispatches, 1);
  await act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await act('cancelWorkflowRun', { workflowRunId: started.workflowRunId });

  const canceledOwner = await waitFor(async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).workflowRuns[started.workflowRunId],
    value => value.compositionAttempts[0].compensations.find(slot => slot.id === 'failure-route')?.status === 'uncertain',
    'parent cancellation dropped the already-started failure compensation');
  assert.equal(canceledOwner.flow.status, 'cancelled');
  assert.deepEqual(canceledOwner.compositionAttempts[0].forwardOutcome, forwardOutcome, 'operator cancellation cannot rewrite the committed forward outcome');
  assert.equal(canceledOwner.compositionAttempts[0].status, 'compensating');
  const retainedFailure = canceledOwner.compositionAttempts[0].compensations.find(slot => slot.id === 'failure-route');
  assert.equal(retainedFailure.runId, failureSlot.runId);
  assert.equal(retainedFailure.effectKey, compensationEffectKey, 'the exact active effect identity remains retained while unknown');
  assert.equal(canceledOwner.compositionAttempts[0].compensations.find(slot => slot.id === 'cancel-route').status, 'cancelled');
  const stateAfterCancel = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(stateAfterCancel.workflowRuns[cancelSlot.runId], undefined, 'cancellation cannot create the alternate compensation child');
  const retainedChild = stateAfterCancel.workflowRuns[failureSlot.runId];
  assert.ok(retainedChild?.parentComposition, 'the original canonical child remains reserved');
  assert.equal(retainedChild.attempt.status, 'uncertain');
  assert.equal(retainedChild.attempt.effectKey, compensationEffectKey);

  await act('claimWorkflowRun', { workflowRunId: compensationRunBefore.id });
  reconciled = true;
  await act('reconcileWorkflowRun', { workflowRunId: compensationRunBefore.id, instance: compensationInstance,
    effectKey: compensationEffectKey, resolution: 'applied' });
  const settled = await waitFor(async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).workflowRuns[started.workflowRunId],
    value => value.compositionAttempts[0].compensations.find(slot => slot.id === 'failure-route')?.status !== 'uncertain',
    'exact compensation reconciliation did not settle');
  assert.equal(settled.flow.status, 'cancelled', 'the existing cancellation outcome remains operator-visible');
  assert.equal(settled.compositionAttempts[0].forwardOutcome.status, 'failed', 'the immutable forward outcome remains truthful');
  assert.equal(settled.compositionAttempts[0].status, 'failed');
  const reconciledChild = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).workflowRuns[failureSlot.runId];
  assert.notEqual(reconciledChild.attempt.status, 'uncertain', 'the exact canonical receipt clears the retained uncertainty');
  assert.equal(reconciledChild.attempt.effectKey, compensationEffectKey);
  assert.equal(compensationDispatches, 1, 'reconciliation never replays the compensation dispatch');
});
