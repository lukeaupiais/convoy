import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { activityDigest } from '../../apps/daemon/src/modules/workflows/index.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const valueSchema = object({ value: { type: 'integer', minimum: 1, maximum: 2 } }, ['value']);

function descriptor(id, effect) {
  return {
    ref: { id, revision: 1 },
    inputSchema: id === 'test.observe-value' ? object({}) : valueSchema,
    outputSchema: valueSchema,
    resources: { location: 'daemon' },
    effect,
    approval: { required: false },
    cancellation: 'immediate',
    confirmation: 'result',
    reconciliation: 'none',
    presentation: { label: id },
  };
}

async function waitFor(read, predicate, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

test('a named activity output resolves to the latest completed source attempt after a bounded review loop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-output-reentry-'));
  const client = 'workflow-output-reentry-acceptance';
  let runtime;
  let sourceDispatches = 0;
  const consumerInputs = [];
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A non-agent re-entry graph must not call a provider.'); },
    runners: {
      execute: async () => { assert.fail('A daemon activity graph must not acquire a runner.'); },
      close: async () => {},
    },
    workflowActivities: [
      {
        descriptor: descriptor('test.observe-value', 'observation'),
        implementation: {
          async prepare() { return {}; },
          async dispatch() {
            sourceDispatches += 1;
            return { state: 'completed', output: { value: sourceDispatches } };
          },
        },
      },
      {
        descriptor: descriptor('test.consume-value', 'pure'),
        implementation: {
          async prepare(input) { return { preparedInput: structuredClone(input) }; },
          async dispatch(_context, input) {
            consumerInputs.push(structuredClone(input));
            return { state: 'completed', output: structuredClone(input) };
          },
        },
      },
    ],
  };
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime(options);
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const organization = await act('createOrganization', {
    slug: `output-reentry-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Output re-entry acceptance',
    kind: 'team',
  });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Activity output re-entry' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  await act('saveWorkflow', {
    projectId: project.id,
    workflow: {
      id: 'activity-output-reentry',
      name: 'Activity output re-entry',
      maxRevisions: 2,
      nodes: [
        { id: 'observe', name: 'Observe', kind: 'action', activity: { id: 'test.observe-value', revision: 1 }, bindings: {} },
        { id: 'review', name: 'Review', kind: 'human', prompt: 'Review the latest observation.' },
        { id: 'consume', name: 'Consume', kind: 'action', activity: { id: 'test.consume-value', revision: 1 }, bindings: {
          value: { from: { kind: 'activity_output', nodeId: 'observe', path: ['value'] } },
        } },
      ],
      edges: [
        { from: 'observe', to: 'review', outcome: 'success' },
        { from: 'review', to: 'observe', outcome: 'changes_requested' },
        { from: 'review', to: 'consume', outcome: 'approved' },
      ],
    },
  });
  const published = (await runtime.snapshot(undefined, client)).workflows.find(item => item.id === 'activity-output-reentry');
  assert.ok(published, 'the workflow is published through the public runtime');
  const started = await act('startWorkflowRun', { projectId: project.id, workflowId: published.id, workflowVersion: published.version });
  const firstGate = await waitFor(
    () => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    run => run.status === 'waiting_gate' && run.nodeId === 'review',
    'first observation did not reach its review gate',
  );
  assert.equal(sourceDispatches, 1);
  await assert.rejects(act('decideWorkflowRun', {
    workflowRunId: started.workflowRunId,
    instance: firstGate.instance,
    decision: 'request_changes',
    feedback: 'Refresh the observation before approval.',
  }), /control|claim/i, 'human gate decisions require the current run lease');
  await act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await act('decideWorkflowRun', {
    workflowRunId: started.workflowRunId,
    instance: firstGate.instance,
    decision: 'request_changes',
    feedback: 'Refresh the observation before approval.',
  });
  const secondGate = await waitFor(
    () => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    run => run.status === 'waiting_gate' && run.nodeId === 'review' && run.instance !== firstGate.instance,
    're-entered observation did not reach a new review instance',
  );
  assert.equal(sourceDispatches, 2);
  await act('decideWorkflowRun', {
    workflowRunId: started.workflowRunId,
    instance: secondGate.instance,
    decision: 'approve',
  });
  const completed = await waitFor(
    () => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    run => ['completed', 'failed', 'interrupted'].includes(run.status),
    'consumer activity did not settle after approval',
  );
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(sourceDispatches, 2);
  assert.deepEqual(consumerInputs, [{ value: 2 }], 'the consumer receives the latest completed execution of its explicitly named source');

  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const savedRun = persisted.workflowRuns[started.workflowRunId];
  const sourceReceipts = savedRun.activityAttempts.filter(attempt => attempt.nodeId === 'observe' && attempt.output);
  assert.equal(sourceReceipts.length, 2);
  assert.notEqual(sourceReceipts[0].instance, sourceReceipts[1].instance);
  assert.deepEqual(sourceReceipts.map(attempt => attempt.output), [{ value: 1 }, { value: 2 }], 'each source execution keeps its immutable receipt');
  assert.deepEqual(savedRun.activityOutputs.observe.value, { value: 2 }, 'the named source index points at its latest completed execution');
  assert.equal(savedRun.attempt.nodeId, 'consume');
  assert.equal(savedRun.attempt.inputDigest, activityDigest({ value: 2 }), 'the consumer attempt pins the exact resolved source value');
  assert.deepEqual(savedRun.attempt.intent.preparedInput, { value: 2 });
  const snapshot = await runtime.snapshot(undefined, client);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(Object.keys(persisted.sessions ?? {}).length, 0);
});
