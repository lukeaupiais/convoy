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
        counters.agentEntered?.();
        await counters.agentBarrier;
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
        if (command.action === 'bind_execution') return {};
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

test('a daemon activity after a real agent session does not acquire configured runner placement', { timeout: 20000 }, async t => {
  let agentEntered;
  const agentEnteredPromise = new Promise(resolve => { agentEntered = resolve; });
  let releaseAgent;
  const agentBarrier = new Promise(resolve => { releaseAgent = resolve; });
  const counters = {
    normalizePrepare: 0, normalizeDispatch: 0, agentPrepare: 0, agentDispatch: 0,
    signalEntered() {}, barrier: Promise.resolve(), agentEntered, agentBarrier,
  };
  const f = await fixture(t, { workflowActivities: registration(counters) });
  const project = await f.act('saveProject', { name: 'Daemon follow-up' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await f.act('registerRunner', {
    name: 'Configured but unused runner', kind: 'local', repository: '/fixture', projectIds: [project.id],
  });
  const runner = (await f.snapshot()).runners[0];
  const conversation = await f.act('createConversation', {
    requestId: 'agent-then-daemon-session', projectId: project.id,
    placement: { mode: 'pinned', runnerId: runner.id },
  });
  await f.act('claim', { sessionId: conversation.sessionId });
  const workflow = {
    id: 'agent-then-daemon', name: 'Agent then daemon transform',
    nodes: [
      { id: 'assess', name: 'Assess record', kind: 'action', model: 'fixture', activity: { id: 'records.assess', revision: 1 }, bindings: {} },
      { id: 'normalize', name: 'Normalize result', kind: 'action', activity: { id: 'records.normalize', revision: 1 }, bindings: {} },
    ],
    edges: [{ from: 'assess', to: 'normalize', outcome: 'success' }],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  await f.act('configure', { sessionId: conversation.sessionId, workflow: workflow.id });
  await f.act('startWorkflow', { sessionId: conversation.sessionId });
  let session;
  try {
    await waitBounded(agentEnteredPromise, 'The real agent activity did not reach dispatch.');
    const callsBeforeDaemon = f.runnerCalls.length;
    releaseAgent();
    for (let i = 0; i < 500; i++) {
      session = (await f.runtime.snapshot(conversation.sessionId, 'agent-resource-acceptance')).sessions.find(value => value.id === conversation.sessionId);
      if (['completed', 'failed'].includes(session?.flow?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(session.flow.status, 'completed', JSON.stringify(session.flow));
    assert.equal(session.placement?.mode, 'pinned', 'the mixed run must carry its configured placement into the real session');
    assert.equal(counters.agentPrepare, 1);
    assert.equal(counters.agentDispatch, 1);
    assert.equal(counters.normalizePrepare, 1);
    assert.equal(counters.normalizeDispatch, 1);
    assert.equal(f.runnerCalls.length, callsBeforeDaemon,
      'the daemon activity must not probe or allocate a configured runner');
  } finally {
    releaseAgent();
  }
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

test('each registered agent adapter receives its exact selected model on a shared linked session', { timeout: 20000 }, async t => {
  const observed = [];
  const activity = [{
    descriptor: {
      ref: { id: 'records.model-check', revision: 1 }, inputSchema: emptyObject, outputSchema: acceptedOutput,
      resources: { location: 'agent', provider: 'required', workspace: false, tools: [] },
      effect: 'pure', approval: { required: false }, cancellation: 'immediate',
      confirmation: 'result', reconciliation: 'none', presentation: { label: 'Check selected model' },
    },
    implementation: {
      async prepare(_input, _identity, context) {
        observed.push({ phase: 'prepare', nodeId: context.node.id, model: context.model,
          sessionModel: context.session?.model, sessionId: context.session?.id });
        return {};
      },
      async dispatch(context) {
        observed.push({ phase: 'dispatch', nodeId: context.node.id, model: context.model,
          sessionModel: context.session?.model, sessionId: context.session?.id });
        return { state: 'completed', output: { accepted: true } };
      },
    },
  }];
  const f = await fixture(t, { models: [{ id: 'fixture-a' }, { id: 'fixture-b' }], workflowActivities: activity });
  const project = await f.act('saveProject', { name: 'Per-activity provider selection' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  const workflow = {
    id: 'per-activity-provider-selection', name: 'Per-activity provider selection',
    nodes: [
      { id: 'first', name: 'Use provider A', kind: 'action', model: 'fixture-a',
        activity: { id: 'records.model-check', revision: 1 }, bindings: {} },
      { id: 'second', name: 'Use provider B', kind: 'action', model: 'fixture-b',
        activity: { id: 'records.model-check', revision: 1 }, bindings: {} },
    ],
    edges: [{ from: 'first', to: 'second', outcome: 'success' }],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  const run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status),
    'Per-activity provider selection did not settle.');
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.deepEqual(observed.map(({ phase, nodeId, model }) => ({ phase, nodeId, model })), [
    { phase: 'prepare', nodeId: 'first', model: 'fixture-a' },
    { phase: 'dispatch', nodeId: 'first', model: 'fixture-a' },
    { phase: 'prepare', nodeId: 'second', model: 'fixture-b' },
    { phase: 'dispatch', nodeId: 'second', model: 'fixture-b' },
  ]);
  const sessionIds = new Set(observed.map(value => value.sessionId));
  assert.equal(sessionIds.size, 1, 'the run should reuse its single linked provider session');
  assert.ok(sessionIds.values().next().value);
  assert.ok(observed.every(value => value.sessionModel === 'fixture-a'),
    'node selection is explicit adapter context, while linked session model metadata remains its original choice');
  assert.equal(run.activityAttempts.filter(value => value.status === 'completed').length, 2);
});

function toolActivity(counters, { workspace = false } = {}) {
  return [{
    descriptor: {
      ref: { id: 'records.inspect-file', revision: 1 }, inputSchema: emptyObject, outputSchema: acceptedOutput,
      resources: { location: 'agent', provider: 'required', workspace, tools: ['read_file'] },
      effect: 'pure', approval: { required: false }, cancellation: 'immediate',
      confirmation: 'result', reconciliation: 'none', presentation: { label: 'Inspect file' },
    },
    implementation: {
      async prepare(_input, _identity, context) {
        counters.prepare += 1;
        assert.ok(context.session?.currentAgentSessionId, 'the activity should receive a real provider session');
        if (workspace) assert.ok(context.session?.workspace, 'the declared workspace requirement must be prepared before activity setup');
        return {};
      },
      async dispatch(context) {
        counters.dispatch += 1;
        assert.ok(context.session?.currentAgentSessionId);
        return { state: 'completed', output: { accepted: true } };
      },
    },
  }];
}

function approvedToolActivity(counters) {
  return [{
    descriptor: {
      ref: { id: 'records.approved-inspection', revision: 1 }, inputSchema: emptyObject, outputSchema: acceptedOutput,
      resources: { location: 'agent', provider: 'required', workspace: true, tools: ['read_file'] },
      effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
      cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
      presentation: { label: 'Inspect approved file' },
    },
    implementation: {
      async prepare(_input, identity, context) {
        counters.prepare += 1;
        assert.equal(context.session, null, 'preparing an approved intent must not acquire a provider session');
        assert.equal(context.run.sessionId, undefined);
        assert.equal(context.run.workspace, undefined, 'preparation must not allocate a workspace');
        const intent = { idempotencyKey: identity.idempotencyKey, model: context.node.model };
        counters.prepared.push({ runId: identity.runId, nodeId: identity.nodeId, instance: identity.instance, intent: structuredClone(intent) });
        return intent;
      },
      async dispatch(context, _input, intent) {
        counters.dispatch += 1;
        assert.ok(context.session?.currentAgentSessionId, 'dispatch must use the lazily acquired provider session');
        assert.ok(context.session?.workspace, 'dispatch must use the declared workspace');
        assert.ok(context.session?.executionGrant?.digest, 'dispatch must use a current execution grant');
        counters.dispatched.push({ runId: context.run.id, nodeId: context.node.id, instance: context.instance, intent: structuredClone(intent) });
        return { state: 'completed', output: { accepted: true } };
      },
      async confirm() { return { state: 'completed', output: { accepted: true } }; },
      async reconcile() { return { state: 'unknown' }; },
    },
  }];
}

async function configureWorkspaceProfile(f, name) {
  let project = await f.act('saveProject', { name });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await f.act('registerRunner', { name: `${name} runner`, kind: 'local', repository: '/fixture' });
  const runner = (await f.snapshot()).runners[0];
  project = await f.act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
  const profile = await f.act('publishProfile', { id: 'approved-file-inspection', name: 'Approved file inspection', tools: ['convoy.read_file'], skills: [] });
  return { project, profile };
}

function approvalWorkflow(projectProfile, id) {
  return {
    id, name: id, capabilityProfile: { id: projectProfile.id, version: projectProfile.version },
    nodes: [
      { id: 'review', name: 'Review file inspection', kind: 'human', prompt: 'Approve the exact file inspection.' },
      { id: 'inspect', name: 'Inspect approved file', kind: 'action', model: 'fixture', permissions: 'read',
        activity: { id: 'records.approved-inspection', revision: 1 }, bindings: {} },
    ],
    edges: [{ from: 'review', to: 'inspect', outcome: 'approved' }],
  };
}

async function prepareApprovedToolRun(f, project, profile, id) {
  const workflow = approvalWorkflow(profile, id);
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  const gate = await waitForRun(f.act, workflowRunId, run => run.status === 'waiting_gate', 'The required activity gate did not activate.');
  await f.act('claimWorkflowRun', { workflowRunId });
  const prepared = await f.act('prepareWorkflowActivity', { workflowRunId, gateInstance: gate.instance, targetNodeId: 'inspect' });
  return { workflowRunId, gate, prepared };
}

test('required agent-resource approval prepares without resources and dispatches the same intent only after approval', { timeout: 20000 }, async t => {
  const counters = { prepare: 0, dispatch: 0, prepared: [], dispatched: [] };
  const f = await fixture(t, { workflowActivities: approvedToolActivity(counters) });
  const { project, profile } = await configureWorkspaceProfile(f, 'Approved file inspection');
  f.runnerCalls.length = 0;
  const { workflowRunId, gate, prepared } = await prepareApprovedToolRun(f, project, profile, 'approved-file-inspection');

  assert.equal(counters.prepare, 1);
  assert.equal(counters.dispatch, 0);
  assert.deepEqual(counters.prepared[0].intent, prepared.preview.intent);
  assert.equal(counters.prepared[0].runId, workflowRunId);
  assert.equal(counters.prepared[0].nodeId, 'inspect');
  assert.match(counters.prepared[0].instance, /^[0-9a-f-]{36}$/i);
  assert.equal((await f.snapshot()).sessions.length, 0, 'a ready approval preview must not attach a provider session');
  assert.deepEqual(f.runnerCalls, [], 'approval preparation must not probe or provision the declared runner');

  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest });
  const run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status), 'Approved agent-resource activity did not settle.');
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(counters.prepare, 1, 'the persisted approval intent must be reused without preparing a second identity');
  assert.equal(counters.dispatch, 1);
  assert.deepEqual(counters.dispatched, [counters.prepared[0]]);
  assert.equal(counters.dispatched[0].intent.idempotencyKey, `${workflowRunId}:${counters.dispatched[0].instance}`);
  assert.ok(f.runnerCalls.includes('provision'), 'workspace acquisition begins only after the approval is consumed');
  const session = (await f.snapshot()).sessions.find(value => value.id === run.sessionId);
  assert.ok(session?.currentAgentSessionId);
  assert.ok(session?.workspace);
  assert.ok(session?.executionGrant?.digest);
});

test('approval preview cannot preserve a tool grant revoked before the approved activity activates', { timeout: 20000 }, async t => {
  const counters = { prepare: 0, dispatch: 0, prepared: [], dispatched: [] };
  const f = await fixture(t, { workflowActivities: approvedToolActivity(counters) });
  const { project, profile } = await configureWorkspaceProfile(f, 'Revoked file inspection');
  f.runnerCalls.length = 0;
  const { workflowRunId, gate, prepared } = await prepareApprovedToolRun(f, project, profile, 'revoked-file-inspection');
  assert.equal(counters.prepare, 1);
  assert.equal(counters.dispatch, 0);
  assert.equal((await f.snapshot()).sessions.length, 0);
  assert.deepEqual(f.runnerCalls, []);

  await f.act('setToolEnabled', { id: 'convoy.read_file', enabled: false });
  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest });
  const run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status), 'Revoked activity authority did not settle.');
  assert.equal(run.status, 'failed', JSON.stringify(run));
  assert.equal(counters.prepare, 1, 'the approved preview cannot be replaced with a wider preparation');
  assert.equal(counters.dispatch, 0, 'current Library authority is rechecked before adapter dispatch');
  assert.equal(counters.dispatched.length, 0);
  assert.ok(run.activityAttempts.find(value => value.nodeId === 'inspect')?.status === 'failed');
});

test('a registered agent activity can use declared workspace tools under current Library and runner grants', { timeout: 20000 }, async t => {
  const counters = { prepare: 0, dispatch: 0 };
  const f = await fixture(t, { workflowActivities: toolActivity(counters, { workspace: true }) });
  let project = await f.act('saveProject', { name: 'Authorized file inspection' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await f.act('registerRunner', { name: 'Authorized file runner', kind: 'local', repository: '/fixture' });
  const runner = (await f.snapshot()).runners[0];
  project = await f.act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
  const profile = await f.act('publishProfile', { id: 'file-inspection', name: 'File inspection', tools: ['convoy.read_file'], skills: [] });
  const workflow = {
    id: 'authorized-file-inspection', name: 'Authorized file inspection',
    capabilityProfile: { id: profile.id, version: profile.version },
    nodes: [{ id: 'inspect', name: 'Inspect file', kind: 'action', model: 'fixture', permissions: 'read',
      activity: { id: 'records.inspect-file', revision: 1 }, bindings: {} }],
    edges: [],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  f.runnerCalls.length = 0;
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  let run;
  try {
    run = await waitForRun(f.act, workflowRunId, value => ['completed', 'failed'].includes(value.status), 'Authorized workspace activity did not settle.');
  } catch (error) {
    const snapshot = await f.snapshot();
    const sessions = snapshot.sessions.map(session => ({ id: session.id, status: session.status,
      queueReason: session.queueReason, assignment: session.assignment, runnerId: session.runnerId, workspace: session.workspace }));
    const runners = snapshot.runners.map(runner => ({ id: runner.id, online: runner.online, enabled: runner.enabled,
      projectIds: runner.projectIds, tools: runner.capabilities?.tools }));
    throw new Error(`${error.message}; counters=${JSON.stringify(counters)}; runnerCalls=${JSON.stringify(f.runnerCalls)}; sessions=${JSON.stringify(sessions)}; runners=${JSON.stringify(runners)}`);
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.ok(run.sessionId, 'the activity has a real linked provider session');
  assert.equal(counters.prepare, 1);
  assert.equal(counters.dispatch, 1);
  assert.ok(f.runnerCalls.includes('provision'), 'the declared workspace must acquire its current authorized runner');
  const session = (await f.snapshot()).sessions.find(value => value.id === run.sessionId);
  assert.ok(session?.workspace);
  assert.ok(session?.executionGrant?.digest, 'the activity runs with a current runner execution grant');
  assert.equal(run.activityAttempts.find(value => value.nodeId === 'inspect')?.status, 'completed');
});

test('a descriptor tool requirement does not grant a tool blocked by the registered action policy', { timeout: 20000 }, async t => {
  const counters = { prepare: 0, dispatch: 0 };
  const f = await fixture(t, { workflowActivities: toolActivity(counters, { workspace: true }) });
  let project = await f.act('saveProject', { name: 'Restricted file inspection' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await f.act('registerRunner', { name: 'Restricted test runner', kind: 'local', repository: '/fixture' });
  const runner = (await f.snapshot()).runners[0];
  project = await f.act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
  const profile = await f.act('publishProfile', { id: 'file-inspection', name: 'File inspection', tools: ['convoy.read_file'], skills: [] });
  const workflow = {
    id: 'restricted-file-inspection', name: 'Restricted file inspection',
    capabilityProfile: { id: profile.id, version: profile.version },
    nodes: [{ id: 'inspect', name: 'Inspect file', kind: 'action', model: 'fixture', permissions: 'none',
      activity: { id: 'records.inspect-file', revision: 1 }, bindings: {} }],
    edges: [],
  };
  await f.act('saveWorkflow', { projectId: project.id, workflow });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id, workflowVersion: 1 });
  const run = await waitForRun(f.act, workflowRunId, value => value.status === 'failed', 'Restricted tool activity did not fail closed.');
  assert.equal(run.nodeId, 'inspect');
  const session = (await f.snapshot()).sessions.find(value => value.id === run.sessionId);
  assert.ok(session?.workspace, 'denial must be attributable to action policy after the declared workspace was available');
  assert.ok(session?.executionGrant?.digest, 'the registered action had a current runner execution grant');
  assert.ok(f.runnerCalls.includes('provision'), 'runner and workspace requirements were otherwise satisfiable');
  assert.equal(counters.prepare, 0, 'Library must reject the descriptor need before activity preparation');
  assert.equal(counters.dispatch, 0, 'a descriptor requirement cannot bypass the action policy');
});
