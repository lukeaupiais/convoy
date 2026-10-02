import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const emptyObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const acceptedOutput = {
  type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false,
};

function registration(counters) {
  return [{
    descriptor: {
      ref: { id: 'records.normalize', revision: 1 }, inputSchema: emptyObject, outputSchema: acceptedOutput,
      resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
      cancellation: 'immediate', confirmation: 'result', reconciliation: 'none',
      presentation: { label: 'Normalize record' },
    },
    implementation: {
      async prepare() { counters.normalizePrepare += 1; return {}; },
      async dispatch() {
        counters.normalizeDispatch += 1;
        counters.signalEntered();
        await counters.barrier;
        return { state: 'completed', output: { accepted: true } };
      },
    },
  }, {
    descriptor: {
      ref: { id: 'records.assess', revision: 1 },
      inputSchema: emptyObject,
      outputSchema: acceptedOutput,
      resources: { location: 'agent', provider: 'required', workspace: false, tools: [] },
      effect: 'pure', approval: { required: false }, cancellation: 'immediate',
      confirmation: 'result', reconciliation: 'none', presentation: { label: 'Assess record' },
    },
    implementation: {
      async prepare(_input, _identity, context) {
        counters.agentPrepare += 1;
        assert.ok(context.session, 'agent resource should be attached before adapter preparation');
        assert.ok(context.session.currentAgentSessionId, 'attached provider session should have an agent session');
        return { providerSessionId: context.session.currentAgentSessionId };
      },
      async dispatch(context) {
        counters.agentDispatch += 1;
        assert.ok(context.session);
        assert.ok(context.session.currentAgentSessionId);
        return { state: 'completed', output: { accepted: true } };
      },
    },
  }];
}

async function waitForRun(act, workflowRunId, predicate, message) {
  for (let i = 0; i < 500; i++) {
    const run = await act('getWorkflowRun', { workflowRunId });
    if (predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${message} Last public run: ${JSON.stringify(await act('getWorkflowRun', { workflowRunId }))}`);
}

async function waitBounded(promise, message, durationMs = 5000) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), durationMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, { models = [{ id: 'fixture' }], workflowActivities }) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-agent-resource-'));
  const runnerCalls = [];
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime({
    directory,
    models,
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A registered action must execute through its activity adapter.'); },
    runners: {
      async execute(_runner, command) {
        runnerCalls.push(command.action);
        if (command.action === 'probe') return { repository: '/fixture', tools: ['read_file', 'shell'], shell: true };
        if (command.action === 'provision') return { path: '/fixture/agent-resource', branch: 'agent-resource' };
        if (command.action === 'remove') return {};
        assert.fail(`Unexpected runner action ${command.action}`);
      },
      async close() {},
    },
    workflowActivities,
  });
  const client = 'agent-resource-acceptance';
  return {
    directory,
    get runtime() { return runtime; },
    act: (action, input = {}) => runtime.command({ action, client, ...input }),
    snapshot: () => runtime.snapshot(undefined, client),
    runnerCalls,
  };
}

test('a standalone provider-only activity lazily attaches a real session without acquiring the configured runner', { timeout: 20000 }, async t => {
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const counters = {
    normalizePrepare: 0, normalizeDispatch: 0, agentPrepare: 0, agentDispatch: 0,
    signalEntered: entered, barrier,
  };
  t.after(() => release());
  const f = await fixture(t, { workflowActivities: registration(counters) });
  const project = await f.act('saveProject', { name: 'Records intake' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await f.act('registerRunner', { name: 'Configured but unused runner', kind: 'local', repository: '/fixture' });
  const runner = (await f.snapshot()).runners[0];
  await f.act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
  // Runner registration and placement may probe the runner; only count dispatch-time work.
  f.runnerCalls.length = 0;
  const workflow = {
    id: 'provider-only-assessment', name: 'Provider-only assessment',
    nodes: [
      { id: 'normalize', name: 'Normalize record', kind: 'action', activity: { id: 'records.normalize', revision: 1 }, bindings: {} },
      { id: 'assess', name: 'Assess record', kind: 'action', model: 'fixture', activity: { id: 'records.assess', revision: 1 }, bindings: {} },
    ],
    edges: [{ from: 'normalize', to: 'assess', outcome: 'success' }],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  let workflowRunId;
  try {
    ({ workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 }));
    await waitBounded(enteredPromise, 'Pure predecessor did not enter dispatch.');
    assert.equal((await f.snapshot()).sessions.length, 0, 'future agent resources must not be acquired while the daemon activity is active');
    assert.deepEqual(f.runnerCalls, [], 'configured placement is not a future resource request');
  } finally {
    release();
  }
  const run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status), 'Provider-only activity did not settle.');
  assert.equal(run.status, 'completed');
  const snapshot = await f.snapshot();
  assert.ok(run.sessionId, 'standalone run must acquire an actual linked provider session');
  assert.equal(snapshot.sessions.filter(value => value.id === run.sessionId).length, 1);
  assert.equal(counters.normalizePrepare, 1);
  assert.equal(counters.normalizeDispatch, 1);
  assert.equal(counters.agentPrepare, 1);
  assert.equal(counters.agentDispatch, 1);
  assert.equal(snapshot.sessions[0].flow?.workflowId, workflow.id);
  assert.deepEqual(f.runnerCalls, [], 'provider-only resources must not acquire the configured runner');
  assert.equal(run.activityAttempts.find(value => value.nodeId === 'assess')?.status, 'completed');
});

test('an unavailable model on a registered agent activity fails before adapter preparation or dispatch', { timeout: 20000 }, async t => {
  const counters = { normalizePrepare: 0, normalizeDispatch: 0, agentPrepare: 0, agentDispatch: 0,
    signalEntered() {}, barrier: Promise.resolve() };
  const f = await fixture(t, { workflowActivities: registration(counters) });
  const project = await f.act('saveProject', { name: 'Unavailable provider model' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  const workflow = {
    id: 'unavailable-provider-assessment', name: 'Unavailable provider assessment',
    nodes: [{ id: 'assess', name: 'Assess record', kind: 'action', model: 'missing-model',
      activity: { id: 'records.assess', revision: 1 }, bindings: {} }],
    edges: [],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  const run = await waitForRun(f.act, workflowRunId, value => value.status === 'failed', 'Unavailable model did not fail closed.');
  assert.equal(run.nodeId, 'assess');
  assert.equal(counters.agentPrepare, 0, 'model authority must be checked before producing an activity intent');
  assert.equal(counters.agentDispatch, 0, 'adapter dispatch must not occur without current model authority');
});

test('each linked agent activity revalidates its own model before its adapter runs', { timeout: 20000 }, async t => {
  const counters = { normalizePrepare: 0, normalizeDispatch: 0, agentPrepare: 0, agentDispatch: 0,
    signalEntered() {}, barrier: Promise.resolve() };
  const f = await fixture(t, { workflowActivities: registration(counters) });
  const project = await f.act('saveProject', { name: 'Per-activity model authority' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  const workflow = {
    id: 'per-activity-model-authority', name: 'Per-activity model authority',
    nodes: [
      { id: 'assess', name: 'Assess record', kind: 'action', model: 'fixture',
        activity: { id: 'records.assess', revision: 1 }, bindings: {} },
      { id: 'reassess', name: 'Reassess record', kind: 'action', model: 'missing-model',
        activity: { id: 'records.assess', revision: 1 }, bindings: {} },
    ],
    edges: [{ from: 'assess', to: 'reassess', outcome: 'success' }],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  const run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status),
    'Per-activity model authorization did not settle.');
  assert.equal(run.status, 'failed', JSON.stringify(run));
  assert.equal(run.nodeId, 'reassess');
  assert.ok(run.sessionId, 'the first permitted activity should retain its linked provider session');
  const first = run.activityAttempts.find(value => value.nodeId === 'assess');
  const second = run.activityAttempts.find(value => value.nodeId === 'reassess');
  assert.equal(first?.status, 'completed');
  assert.ok(first?.outputDigest, 'the exact first activity receipt remains recorded');
  assert.equal(second?.status, 'failed');
  assert.equal(counters.agentPrepare, 1, 'the second node model must be checked before preparing its intent');
  assert.equal(counters.agentDispatch, 1, 'the second node model must be checked before adapter dispatch');
});
