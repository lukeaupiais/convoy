import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowEngine, normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/workflows.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/default-workflow.mjs';
import { createAutomations, initializeAutomations } from '../../apps/daemon/src/modules/workflows/index.mjs';

test('legacy automation state requires explicit offline migration', () => {
  assert.throws(() => initializeAutomations({ workflowStartRules: [] }), /offline migration/);
  const state = {};
  initializeAutomations(state);
  assert.equal(state.automationSchemaVersion, 1);
  assert.deepEqual(state.automations, []);
});

test('the delivery template models plan, implementation, verification, review, and bounded repair', () => {
  const workflow = normalizeWorkflow(defaultWorkflowDefinition);
  assert.deepEqual(
    workflow.nodes.map((node) => node.id),
    ['plan', 'approve-plan', 'implement', 'verify', 'review'],
  );
  assert.deepEqual(
    workflow.edges.map(({ from, to, outcome }) => ({ from, to, outcome })),
    [
      { from: 'plan', to: 'approve-plan', outcome: 'success' },
      { from: 'approve-plan', to: 'implement', outcome: 'approved' },
      { from: 'approve-plan', to: 'plan', outcome: 'changes_requested' },
      { from: 'implement', to: 'verify', outcome: 'success' },
      { from: 'verify', to: 'implement', outcome: 'failed' },
      { from: 'verify', to: 'review', outcome: 'success' },
      { from: 'review', to: 'implement', outcome: 'changes_requested' },
    ],
  );
  assert.equal(workflow.maxRevisions, 3);
  assert.equal(workflow.nodes.find((node) => node.id === 'plan').permissions, 'read-write');
  assert.match(workflow.nodes.find((node) => node.id === 'verify').checkCommand, /fs\.readdirSync/);
  assert.match(workflow.nodes.find((node) => node.id === 'plan').prompt, /canonical success outcome/i);
  assert.match(workflow.nodes.find((node) => node.id === 'implement').prompt, /Do not push, merge or deploy/i);
});

test('the delivery template completes a plan, check failure repair, and human review loop end to end', async () => {
  const artifacts = {
    'implementation-brief.md': '# Scope\nS\n# Acceptance criteria\nA\n# Plan\nP\n# Verification\nV\n# Risks\nR',
    'verification-report.md': '# Checks\nC\n# Results\nR\n# Limitations\nL\n# Revision\n2',
  };
  const session = {
    id: 'delivery', messages: [], checks: [], events: [], workspace: { path: '/fixture' },
    workflow: { ...structuredClone(defaultWorkflowDefinition), version: 1 },
  };
  const engine = createWorkflowEngine({
    state: { sessions: { delivery: session } }, save: async () => {},
    event: (s, type, data) => s.events.push({ type, ...data }),
    inspectArtifact: async (_s, path) => ({ text: artifacts[path], sha256: path }),
    inspectChanges: async () => ({ digest: 'revision-2' }), busy: () => false, launch: () => true,
  });
  const submit = async (outcome = 'success') => engine.submit(session, session.flow.instance, {
    summary: 'Completed',
    artifacts: session.flow.nodeId === 'plan' ? ['implementation-brief.md'] : session.flow.nodeId === 'verify' ? ['verification-report.md'] : [],
    outcome,
  });
  await engine.start(session); await engine.pump(); await submit();
  await engine.decide(session, { action: 'approveGate', instance: session.flow.instance });
  await engine.pump(); await submit(); await engine.pump();
  session.checks.push({ instance: session.flow.instance, command: defaultWorkflowDefinition.nodes.find((node) => node.id === 'verify').checkCommand, code: 1, stopped: false, concurrent: false, digest: 'revision-2' });
  await submit('failed');
  assert.equal(session.flow.nodeId, 'implement');
  assert.equal(session.flow.revision, 1);
  await engine.pump(); await submit(); await engine.pump();
  session.checks.push({ instance: session.flow.instance, command: defaultWorkflowDefinition.nodes.find((node) => node.id === 'verify').checkCommand, code: 0, stopped: false, concurrent: false, digest: 'revision-2' });
  await submit();
  assert.equal(session.flow.nodeId, 'review');
  await engine.decide(session, { action: 'requestChanges', instance: session.flow.instance, feedback: 'Cover the edge case.' });
  assert.equal(session.flow.nodeId, 'implement');
  assert.equal(session.flow.revision, 2);
  await engine.pump(); await submit(); await engine.pump();
  session.checks.push({ instance: session.flow.instance, command: defaultWorkflowDefinition.nodes.find((node) => node.id === 'verify').checkCommand, code: 0, stopped: false, concurrent: false, digest: 'revision-2' });
  await submit();
  await engine.decide(session, { action: 'approveGate', instance: session.flow.instance });
  assert.equal(session.flow.status, 'completed');
  assert.equal(session.status, 'accepted');
});

function setup({ artifact, advance = 'automatic', inspectArtifact = async () => ({ text: '# Scope\nWork', sha256: 'hash' }), captureArtifacts } = {}) {
  const s = { id: '1', messages: [], checks: [], events: [], workspace: artifact ? { path: '/fixture' } : null, workflow: { ...normalizeWorkflow({ name: 'Test', steps: [{ name: 'Work', kind: 'agent', prompt: 'Do work', artifact, advance }] }), version: 1 } };
  const engine = createWorkflowEngine({ state: { sessions: { 1: s } }, save: async () => {}, event: (s, type, data) => s.events.push({ type, ...data }), inspectArtifact, captureArtifacts, inspectChanges: async () => ({ digest: 'code' }), busy: () => false, launch: () => true, abort: () => {} });
  return { s, engine };
}
test('submission requires every artifact and required heading', async () => {
  const { s, engine } = setup({ artifact: { path: 'brief.md', headings: ['Scope', 'Plan'] } });
  await engine.start(s); await engine.pump();
  await assert.rejects(engine.submit(s, s.flow.instance, { summary: 'Done', artifacts: [] }), /Include brief/);
  await assert.rejects(engine.submit(s, s.flow.instance, { summary: 'Done', artifacts: ['brief.md'] }), /Missing sections: Plan/);
  assert.equal(s.step, 0); assert.equal(s.flow.status, 'running');
});
test('a workflow submission exposes one immutable review bundle for all submitted artifacts', async () => {
  const captured = [
    { id: 'plan-snapshot', path: 'plan.md', name: 'plan.md', mime: 'text/plain', size: 42, hash: 'plan-hash', at: '2026-09-19T12:00:00.000Z' },
    { id: 'risk-snapshot', path: 'notes/risks.md', name: 'risks.md', mime: 'text/plain', size: 21, hash: 'risk-hash', at: '2026-09-19T12:00:00.000Z' },
  ];
  const { s, engine } = setup({
    artifact: { path: 'plan.md', headings: ['Scope'] },
    captureArtifacts: async (_session, paths) => {
      assert.deepEqual(paths, ['plan.md', 'notes/risks.md']);
      return captured;
    },
  });
  await engine.start(s); await engine.pump();
  await engine.submit(s, s.flow.instance, { summary: 'Plan ready for review', artifacts: ['plan.md', 'notes/risks.md'] });
  assert.deepEqual(s.flow.lastSubmission, {
    nodeId: 'step-1', step: 'Work', summary: 'Plan ready for review', revision: 1,
    primaryArtifactId: 'plan-snapshot', artifacts: captured,
  });
});
test('pausing during artifact validation cannot advance the step', async () => {
  let release;
  const { s, engine } = setup({ artifact: { path: 'brief.md', headings: [] }, inspectArtifact: () => new Promise(r => { release = r; }) });
  await engine.start(s); await engine.pump();
  const submitted = engine.submit(s, s.flow.instance, { summary: 'Done', artifacts: ['brief.md'] });
  await engine.pause(s); release({ text: 'Content', sha256: 'hash' });
  await assert.rejects(submitted, /changed during validation/); assert.equal(s.step, 0); assert.equal(s.flow.status, 'paused');
});
test('a check run beside a session command is never accepted as workflow evidence', async () => {
  const workflow = { ...normalizeWorkflow({ name: 'Checked', steps: [{ name: 'Verify', kind: 'agent', prompt: 'Verify', requiresCheck: true, checkCommand: 'npm test' }] }), version: 1 };
  const s = { id: 'checked', messages: [], checks: [], events: [], workspace: { path: '/fixture' }, workflow };
  const engine = createWorkflowEngine({ state: { sessions: { checked: s } }, save: async () => {}, event: (session, type, data) => session.events.push({ type, ...data }), inspectChanges: async () => ({ digest: 'code' }), busy: () => false, launch: () => true });
  await engine.start(s); await engine.pump();
  s.checks.push({ instance: s.flow.instance, command: 'npm test', code: 0, stopped: false, concurrent: true, digest: 'code' });
  await assert.rejects(engine.submit(s, s.flow.instance, { summary: 'Done', artifacts: [] }), /must pass/);
  s.checks[0].concurrent = false; await engine.submit(s, s.flow.instance, { summary: 'Done', artifacts: [] }); assert.equal(s.status, 'accepted');
});
test('stale manual evidence can be explicitly invalidated and resubmitted', async () => {
  let hash = 'old';
  const { s, engine } = setup({ advance: 'manual', artifact: { path: 'brief.md', headings: [] }, inspectArtifact: async () => ({ text: 'Content', sha256: hash }) });
  await engine.start(s); await engine.pump(); const previous = s.flow.instance;
  await engine.submit(s, previous, { summary: 'Done', artifacts: ['brief.md'] }); hash = 'new';
  await assert.rejects(engine.decide(s, { action: 'continueWorkflow', instance: previous }), /evidence changed/);
  await engine.decide(s, { action: 'reviseSubmission', instance: previous }); assert.notEqual(s.flow.instance, previous);
  await assert.rejects(engine.submit(s, previous, { summary: 'Done', artifacts: ['brief.md'] }), /changed/);
});

test('graph definitions require explicit outcomes and cap revision loops', async () => {
  const graph = normalizeWorkflow({ id: 'revision-loop', name: 'Revision loop', maxRevisions: 1, nodes: [
    { id: 'review', kind: 'human', name: 'Review', prompt: 'Review the result' },
  ], edges: [{ from: 'review', to: 'review', outcome: 'changes_requested' }] });
  assert.equal(graph.schemaVersion, 3);
  assert.deepEqual(graph.edges.map(({ from, to, outcome }) => ({ from, to, outcome })), [{ from: 'review', to: 'review', outcome: 'changes_requested' }]);
  const s = { id: 'loop', messages: [], checks: [], events: [], workflow: graph };
  const engine = createWorkflowEngine({ state: { sessions: { loop: s } }, save: async () => {}, event: (session, type, data) => session.events.push({ type, ...data }), busy: () => false, launch: () => true });
  await engine.start(s);
  await engine.decide(s, { action: 'requestChanges', instance: s.flow.instance, feedback: 'Try again' });
  assert.equal(s.flow.revision, 1);
  await assert.rejects(engine.decide(s, { action: 'requestChanges', instance: s.flow.instance, feedback: 'Still not right' }), /revision limit/i);
  assert.equal(s.flow.status, 'waiting_gate');
  assert.throws(() => normalizeWorkflow({ id: 'unbounded', name: 'Unbounded', nodes: [
    { id: 'one', kind: 'human', name: 'One', prompt: 'Approve' },
  ], edges: [{ from: 'one', to: 'one', outcome: 'success' }] }), /unbounded loop/i);
});

test('a branching agent must choose a configured outcome before its submission is accepted', async () => {
  const s = { id: 'routing', messages: [], checks: [], events: [], workflow: normalizeWorkflow({
    id: 'editorial-routing', name: 'Editorial routing', nodes: [
      { id: 'classify', name: 'Classify', kind: 'agent', prompt: 'Choose a review route.' },
      { id: 'review', name: 'Review', kind: 'human', prompt: 'Review the draft.' },
    ], edges: [{ from: 'classify', to: 'review', outcome: 'clarify' }],
  }) };
  const engine = createWorkflowEngine({ state: { sessions: { routing: s } }, save: async () => {}, event: (session, type, data) => session.events.push({ type, ...data }), launch: () => true });
  await engine.start(s); await engine.pump();
  for (const outcome of [undefined, 'success', 'wrong']) {
    await assert.rejects(engine.submit(s, s.flow.instance, { summary: 'Needs clarification', artifacts: [], ...(outcome ? { outcome } : {}) }), /Choose an exact workflow outcome identifier/);
    assert.equal(s.flow.status, 'running');
    assert.equal(s.flow.lastSubmission, undefined);
    assert.equal(s.flow.history.length, 0);
  }
  await engine.submit(s, s.flow.instance, { summary: 'Needs clarification', artifacts: [], outcome: 'clarify' });
  assert.equal(s.flow.status, 'waiting_gate');
});

test('investigation settings pin valid budgets and evidence sections', () => {
  const workflow = structuredClone(defaultWorkflowDefinition);
  const node = workflow.nodes.find(n => n.kind === 'agent');
  Object.assign(node, {maxRounds: 12, finalizationRounds: 2, reasoningEffort: 'medium', summaryHeadings: ['Evidence', 'Unknowns']});
  assert.equal(normalizeWorkflow(workflow).nodes.find(n => n.id === node.id).reasoningEffort, 'medium');
  for (const [key, value] of [['finalizationRounds', 12], ['reasoningEffort', 'invalid'], ['summaryHeadings', ['Evidence', 'Evidence']]]) {
    const copy = structuredClone(workflow); copy.nodes.find(n => n.id === node.id)[key] = value;
    assert.throws(() => normalizeWorkflow(copy));
  }
});

test('missing evidence section rejects submission without advancing the workflow', async () => {
  const workflow = structuredClone(defaultWorkflowDefinition);
  workflow.nodes.find(n => n.id === 'plan').summaryHeadings = ['Evidence', 'Unknowns'];
  const session = {id: 'evidence', messages: [], checks: [], events: [], workspace: {path: '/fixture'}, workflow: {...workflow, version: 1}};
  const engine = createWorkflowEngine({state: {sessions: {evidence: session}}, save: async () => {}, event: (s, type, data) => s.events.push({type, ...data}), busy: () => false, launch: () => true});
  await engine.start(session); await engine.pump();
  for (const summary of ['Unstructured answer', '# Evidence\n\n# Unknowns\nNone', '# Evidence\nSource read\n# Unknowns']) {
    await assert.rejects(engine.submit(session, session.flow.instance, {summary, artifacts: ['implementation-brief.md'], outcome: 'success'}), /nonempty Markdown section/);
    assert.equal(session.flow.nodeId, 'plan'); assert.equal(session.flow.status, 'running');
    assert.equal(session.events.at(-1).type, 'submission_rejected');
  }
});

test('ordinary workflow response preserves waits and limits completion correction to exploration', async () => {
  const events = [];
  const engine = createWorkflowEngine({ state: { sessions: {} }, save: async () => {}, event: (_s, type, data) => events.push({ type, ...data }) });
  const budget = { round: 1, maxRounds: 8, finalizing: false };
  for (const status of ['paused', 'cancelled', 'waiting_gate', 'waiting_event', 'completed']) {
    const s = { flow: { instance: 'current', status }, status };
    assert.deepEqual(await engine.ordinaryResponse(s, 'current', { budget }), { stop: true });
    assert.equal(s.status, status);
  }
  for (const pendingField of ['pending', 'pendingQuestion']) {
    const s = { flow: { instance: 'current', status: 'running' }, status: 'waiting', [pendingField]: { id: 'pending' } };
    assert.deepEqual(await engine.ordinaryResponse(s, 'current', { budget }), { stop: true });
    assert.equal(s.status, 'waiting');
  }
  assert.equal(events.length, 0);
  const s = { flow: { instance: 'current', status: 'running' }, status: 'running' };
  await assert.rejects(engine.ordinaryResponse(s, 'stale', { budget }), /step has changed/);
  const decision = await engine.ordinaryResponse(s, 'current', { budget: { ...budget, round: 6, finalizing: true } });
  assert.equal(decision.stop, true);
  assert.equal(s.status, 'awaiting_submission');
  assert.equal(events.at(-1).reason, 'finalization');
});

test('cancelling a workflow clears stale queued execution and can reconcile an already cancelled run', async () => {
  const engine = createWorkflowEngine({ state: { sessions: {} }, save: async () => {}, event: () => {} });
  for (const status of ['paused', 'cancelled']) {
    const s = { flow: { status }, queuedInput: 'Old workflow input', queueReason: 'Old placement failure' };
    await engine.pause(s, true);
    assert.equal(s.flow.status, 'cancelled');
    assert.equal(s.queuedInput, undefined);
    assert.equal(s.queueReason, undefined);
  }
});

 test('workflow request budgets accept extended investigations and retain bounds', () => {
  for (const rounds of [35, 100]) {
    const workflow = structuredClone(defaultWorkflowDefinition);
    workflow.nodes[0].maxRounds = rounds;
    assert.equal(normalizeWorkflow(workflow).nodes[0].maxRounds, rounds);
  }
  for (const rounds of [0, 101, 35.5]) {
    const workflow = structuredClone(defaultWorkflowDefinition);
    workflow.nodes[0].maxRounds = rounds;
    assert.throws(() => normalizeWorkflow(workflow), /1–100 agent rounds/);
  }
});
