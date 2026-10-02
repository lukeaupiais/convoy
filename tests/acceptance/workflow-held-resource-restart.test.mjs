import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read, predicate, message) {
  for (let index = 0; index < 500; index++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

test('a future runner requirement stays pre-dispatch and retryable after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-held-resource-restart-'));
  const runnerCalls = [];
  const options = {
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('This run has no agent activity.'); },
    runners: { async execute(_runner, request) { runnerCalls.push(request.action); return {}; }, async close() {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const client = 'held-resource-restart';
  const act = (action, input = {}) => runtime.command({ action, client, ...input });
  const project = await act('saveProject', { name: 'Held resource test' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'pure-before-runner', name: 'Pure before runner', nodes: [
      { id: 'normalize', kind: 'action', name: 'Normalize', activity: { id: 'data.multiply', revision: 1 },
        bindings: { amount: { literal: 4 }, factor: { literal: 3 } } },
      { id: 'inspect', kind: 'action', name: 'Inspect', activity: { id: 'runner.inspect-changes', revision: 1 }, bindings: {} },
    ], edges: [{ from: 'normalize', to: 'inspect', outcome: 'success' }],
  } });
  const started = await act('startWorkflowRun', { projectId: project.id, workflowId: 'pure-before-runner', workflowVersion: 1 });
  const held = await until(() => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    run => run.nodeId === 'inspect' && ['paused', 'ready'].includes(run.status), 'run did not hold at its runner activity');
  assert.ok(['waiting', 'ready'].includes(held.attempt.status));
  assert.equal(held.activityAttempts.find(attempt => attempt.nodeId === 'normalize').status, 'completed');
  assert.equal(runnerCalls.length, 0);

  await runtime.close();
  runtime = await createRuntime(options);
  let recovered = await act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(recovered.nodeId, 'inspect');
  assert.ok(['paused', 'ready'].includes(recovered.status));
  assert.ok(['waiting', 'ready'].includes(recovered.attempt.status));
  assert.notEqual(recovered.attempt.status, 'uncertain');
  assert.equal(recovered.activityAttempts.find(attempt => attempt.nodeId === 'normalize').outputDigest,
    held.activityAttempts.find(attempt => attempt.nodeId === 'normalize').outputDigest);
  await act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  await act('continueWorkflowRun', { workflowRunId: started.workflowRunId, instance: recovered.instance });
  recovered = await until(() => act('getWorkflowRun', { workflowRunId: started.workflowRunId }),
    run => run.nodeId === 'inspect' && ['paused', 'ready'].includes(run.status) && ['waiting', 'ready'].includes(run.attempt.status),
    'held runner activity did not remain retryable');
  assert.notEqual(recovered.attempt.status, 'uncertain');
  assert.equal(runnerCalls.length, 0);
});
