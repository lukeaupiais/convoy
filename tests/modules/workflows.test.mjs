import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowEngine, normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/workflows.mjs';
import { createWorkflowRegistry } from '../../apps/daemon/src/modules/workflows/workflow-registry.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/default-workflow.mjs';
import { createAutomations, initializeAutomations } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { createWorkflows } from '../../apps/daemon/src/modules/workflows/workflow-module.mjs';

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

test('legacy workflow selection and revision publication interpret missing owner/version without rewriting the pin', async () => {
  const legacy = { id: 'delivery', name: 'Legacy delivery', steps: [{ name: 'Work', kind: 'agent', prompt: 'Work' }] };
  const state = {
    workflows: [structuredClone(legacy)],
    workflowDrafts: {},
    projects: [{ id: 'agent-platform', organizationId: 'personal' }],
  };
  const before = JSON.stringify(state.workflows[0]);
  const workflows = createWorkflows({
    state, save: async () => {}, defaultWorkflow: { id: 'other', name: 'Other', version: 1, steps: [] },
    normalize: normalizeWorkflow, validateBindings: () => {}, engine: {}, effects: {}, requestStop: async () => {},
    automations: { snapshot: () => ({}) },
  });

  const selected = workflows.selection('delivery', { projectId: 'agent-platform' });
  assert.equal(selected.organizationId, 'personal');
  assert.equal(selected.version, 1);
  assert.equal(JSON.stringify(state.workflows[0]), before);

  const published = await workflows.registry.publish({
    organizationId: 'personal',
    baseVersion: 1,
    workflow: { ...structuredClone(legacy), name: 'Legacy delivery revision' },
  });
  assert.equal(published.version, 2);
  assert.equal(published.organizationId, 'personal');
  assert.equal(
    JSON.stringify(state.workflows[0]),
    before,
    'publishing a new revision does not rewrite the historical pin',
  );
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
    nodeId: 'step-1', instance: s.flow.history[0].instance, step: 'Work', summary: 'Plan ready for review', revision: 1,
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


test('reply actions require a declared draft and a human approval route', () => {
  const draft = { id: 'draft', name: 'Draft', kind: 'agent', submissionRequirements: { success: { fields: ['message'], minReferences: 0 } } };
  const review = { id: 'review', name: 'Review', kind: 'human' };
  const send = { id: 'send', name: 'Send', kind: 'action', operation: 'send_external_reply', input: { connectionId: 'source', sourceNodeId: 'draft', field: 'message' } };
  const workflow = { id: 'reply', name: 'Reply', nodes: [draft, review, send], edges: [
    { from: 'draft', to: 'review', outcome: 'success' }, { from: 'review', to: 'send', outcome: 'approved' },
  ] };
  assert.equal(normalizeWorkflow(workflow).nodes[2].operation, 'send_external_reply');
  assert.throws(() => normalizeWorkflow({ ...workflow, nodes: [draft, review, { ...send, input: { ...send.input, field: 'other' } }] }), /declared/);
  assert.throws(() => normalizeWorkflow({ ...workflow, edges: [{ from: 'draft', to: 'review', outcome: 'success' }, { from: 'review', to: 'send', outcome: 'success' }] }), /approval edge/);
  assert.throws(() => normalizeWorkflow({ ...workflow, nodes: [draft, review, { ...send, input: { ...send.input, body: 'Unreviewed text' } }] }), /submitted detail field/);
});

test('create_ticket can inherit its governed project while rejecting an invalid explicit project', () => {
  const workflow = normalizeWorkflow({ id: 'governed-create', name: 'Create in run project', nodes: [
    { id: 'create', name: 'Create', kind: 'action', operation: 'create_ticket', input: { title: 'Estimate' } },
  ] }, { publishing: true });
  assert.equal(workflow.nodes[0].input.title, 'Estimate');
  assert.equal(Object.hasOwn(workflow.nodes[0].input, 'projectId'), false);
  for (const projectId of ['', 42, null]) {
    assert.throws(() => normalizeWorkflow({ id: 'invalid-governed-create', name: 'Invalid create', nodes: [
      { id: 'create', name: 'Create', kind: 'action', operation: 'create_ticket', input: { title: 'Estimate', projectId } },
    ] }, { publishing: true }), /create_ticket/);
  }
});

test('human decision labels normalize, pin with a run, and reject invalid metadata', async () => {
  const workflow = normalizeWorkflow({ id: 'decision-labels', name: 'Decision labels', nodes: [
    { id: 'review', name: 'Review', kind: 'human', decisionLabels: { approved: 'Approve & send', changes_requested: 'Revise estimate' } },
  ] }, { publishing: true });
  assert.deepEqual(workflow.nodes[0].decisionLabels, { approved: 'Approve & send', changes_requested: 'Revise estimate' });
  const session = { id: 'decision-labels-run', messages: [], checks: [], events: [], workflow };
  const engine = createWorkflowEngine({ state: { sessions: { [session.id]: session } }, save: async () => {}, event: () => {}, launch: () => true });
  await engine.start(session);
  assert.deepEqual(session.workflow.nodes[0].decisionLabels, workflow.nodes[0].decisionLabels);
  assert.throws(() => normalizeWorkflow({ id: 'unsupported-label', name: 'Unsupported label', nodes: [
    { id: 'review', name: 'Review', kind: 'human', decisionLabels: { cancelled: 'Cancel' } },
  ] }), /supported human outcomes/);
  assert.throws(() => normalizeWorkflow({ id: 'bad-label', name: 'Bad label', nodes: [
    { id: 'review', name: 'Review', kind: 'human', decisionLabels: { approved: '  ' } },
  ] }), /plain text up to 80 characters/);
  assert.throws(() => normalizeWorkflow({ id: 'wrong-node', name: 'Wrong node', nodes: [
    { id: 'work', name: 'Work', kind: 'agent', decisionLabels: { approved: 'Proceed' } },
  ] }), /supported human outcomes/);
});

test('approval preserves the captured draft and rejects a missing draft without advancing', async () => {
  const session = { id: 'reply', messages: [], checks: [], events: [], workspace: null, workflow: normalizeWorkflow({ id: 'reply', name: 'Reply', nodes: [
    { id: 'draft', name: 'Draft', kind: 'agent', submissionRequirements: { success: { fields: ['message'], minReferences: 0 } } },
    { id: 'review', name: 'Review', kind: 'human' },
    { id: 'send', name: 'Send', kind: 'action', operation: 'send_external_reply', input: { connectionId: 'source', sourceNodeId: 'draft', field: 'message' } },
  ], edges: [{ from: 'draft', to: 'review', outcome: 'success' }, { from: 'review', to: 'send', outcome: 'approved' }] }) };
  const engine = createWorkflowEngine({ state: { sessions: { reply: session } }, save: async () => {}, event: () => {}, launch: () => true });
  await engine.start(session); await engine.pump();
  await engine.submit(session, session.flow.instance, { summary: 'Proposal', artifacts: [], details: { message: 'Exact reviewed text' }, references: [] });
  const draft = structuredClone(session.flow.lastSubmission);
  const instance = session.flow.instance;
  session.flow.lastSubmission.details.message = 'Mutable later summary';
  await engine.decide(session, { action: 'approveGate', instance });
  assert.equal(session.flow.approvedSubmission.submission.details.message, 'Exact reviewed text');
  assert.equal(session.flow.approvedSubmission.reviewInstance, instance);
  assert.deepEqual(session.flow.approvedSubmission.sourceSubmissionRef, { nodeId: 'draft', instance: draft.instance, revision: draft.revision });
  assert.equal(session.flow.nodeId, 'send');
});

test('presentation bindings validate against each workflow purpose and keep empty-artifact outputs valid', () => {
  const calculation = normalizeWorkflow({ id: 'calculation', name: 'Quarterly total', nodes: [
    { id: 'sum', name: 'Calculate', kind: 'agent', submissionRequirements: { success: { fields: ['total'], minReferences: 0 } },
      presentationBindings: [{ source: 'detail', field: 'total', label: 'Quarterly total', primary: true }, { source: 'summary' }] },
  ] });
  const editorial = normalizeWorkflow({ id: 'editorial', name: 'Editorial review', nodes: [
    { id: 'draft', name: 'Draft', kind: 'agent', artifact: { path: 'article.md', headings: [] },
      submissionRequirements: { success: { fields: ['headline'], minReferences: 0 } },
      presentationBindings: [{ source: 'artifact', label: 'Article' }, { source: 'detail', field: 'headline', label: 'Headline', primary: true }] },
  ] });
  assert.equal(calculation.nodes[0].presentationBindings[0].primary, true);
  assert.equal(editorial.nodes[0].presentationBindings[0].source, 'artifact');
  assert.throws(() => normalizeWorkflow({ id: 'bad', name: 'Bad binding', nodes: [
    { id: 'work', name: 'Work', kind: 'agent', submissionRequirements: { success: { fields: ['known'], minReferences: 0 } },
      presentationBindings: [{ source: 'detail', field: 'unknown' }] },
  ] }), /detail field must be declared/);
  assert.throws(() => normalizeWorkflow({ id: 'two-primary', name: 'Two primary', nodes: [
    { id: 'work', name: 'Work', kind: 'agent', presentationBindings: [{ source: 'summary', primary: true }, { source: 'artifact', primary: true }] },
  ] }), /one primary/);
  assert.throws(() => normalizeWorkflow({ id: 'duplicate', name: 'Duplicate', nodes: [
    { id: 'work', name: 'Work', kind: 'agent', presentationBindings: [{ source: 'summary' }, { source: 'summary', label: 'Again' }] },
  ] }), /duplicate presentation binding/);
});

test('agent submissions keep exact source identity in history across human and action completions', async () => {
  const session = { id: 'identity', messages: [], checks: [], events: [], workflow: normalizeWorkflow({ id: 'identity', name: 'Inventory estimate', nodes: [
    { id: 'estimate', name: 'Estimate stock', kind: 'agent', submissionRequirements: { success: { fields: ['quantity'], minReferences: 0 } },
      presentationBindings: [{ source: 'detail', field: 'quantity', label: 'Estimated quantity', primary: true }] },
    { id: 'review', name: 'Review estimate', kind: 'human' },
    { id: 'record', name: 'Record estimate', kind: 'action', operation: 'create_ticket', input: { title: 'Count estimate', projectId: 'inventory' } },
  ], edges: [{ from: 'estimate', to: 'review', outcome: 'success' }, { from: 'review', to: 'record', outcome: 'approved' }] }) };
  const engine = createWorkflowEngine({ state: { sessions: { identity: session } }, save: async () => {}, event: () => {}, launch: () => true });
  await engine.start(session); await engine.pump();
  const sourceInstance = session.flow.instance;
  await engine.submit(session, sourceInstance, { summary: 'Estimated 14 units.', artifacts: [], details: { quantity: '14' }, references: [] });
  assert.equal(session.flow.status, 'waiting_gate');
  assert.deepEqual(session.flow.decisionSubmissionRef, { nodeId: 'estimate', instance: sourceInstance, revision: 1 });
  const sourceRecord = session.flow.history.find(entry => entry.instance === sourceInstance);
  assert.equal(sourceRecord.submission.details.quantity, '14');
  assert.deepEqual({ nodeId: sourceRecord.sourceEvidence.sourceNodeId, instance: sourceRecord.sourceEvidence.sourceInstance }, { nodeId: 'estimate', instance: sourceInstance });
  const gateInstance = session.flow.instance;
  await engine.decide(session, { action: 'approveGate', instance: gateInstance });
  assert.equal(session.flow.lastSubmission.summary, 'Human approved');
  assert.deepEqual(session.flow.history.find(entry => entry.instance === gateInstance).decisionSubmissionRef,
    { nodeId: 'estimate', instance: sourceInstance, revision: 1 });
  session.flow.status = 'running';
  await engine.finishAutomated(session, session.flow.instance, 'success', { created: true });
  assert.equal(session.flow.lastSubmission.summary, 'Record estimate completed');
  assert.equal(session.flow.history.find(entry => entry.instance === sourceInstance).submission.details.quantity, '14');
  assert.equal(session.flow.history.find(entry => entry.instance === gateInstance).submission, undefined);
});

test('a pinned human decision cannot approve when its exact source package is missing or mismatched', async () => {
  for (const damage of ['missing-history', 'wrong-instance']) {
    const session = { id: `lost-${damage}`, messages: [], checks: [], events: [], workflow: normalizeWorkflow({ id: `lost-${damage}`, name: 'Review result', nodes: [
      { id: 'result', name: 'Calculate', kind: 'agent' },
      { id: 'review', name: 'Review', kind: 'human' },
    ], edges: [{ from: 'result', to: 'review', outcome: 'success' }] }) };
    const engine = createWorkflowEngine({ state: { sessions: { [session.id]: session } }, save: async () => {}, event: () => {}, launch: () => true });
    await engine.start(session); await engine.pump();
    await engine.submit(session, session.flow.instance, { summary: 'Result is 42.', artifacts: [] });
    if (damage === 'missing-history') session.flow.history = [];
    else session.flow.decisionSubmissionRef.instance = 'another-instance';
    await assert.rejects(engine.decide(session, { action: 'approveGate', instance: session.flow.instance }), /exact decision submission is unavailable/);
    assert.equal(session.flow.status, 'waiting_gate');
  }
});

test('workflow publication rejects unsupported human choices while preserving supported wildcards', async () => {
  const supported = { id: 'wildcard', name: 'Wildcard review', nodes: [
    { id: 'review', name: 'Review', kind: 'human' },
    { id: 'done', name: 'Done', kind: 'agent' },
  ], edges: [{ from: 'review', to: 'done', outcome: '*' }] };
  const state = { workflows: [], workflowDrafts: {} };
  const registry = createWorkflowRegistry({ state, save: async () => {}, normalize: normalizeWorkflow, validateBindings: () => {} });
  await assert.rejects(registry.publish({ workflow: { ...supported, edges: [{ from: 'review', to: 'done', outcome: 'rejected' }] } }), /unsupported human outcome rejected/);
  const published = await registry.publish({ workflow: supported });
  assert.equal(published.edges[0].outcome, '*');
  const legacy = await registry.publish({ workflow: { id: 'legacy', name: 'Legacy review', steps: [
    { id: 'start', kind: 'agent', name: 'Start' }, { id: 'review', kind: 'human', name: 'Review' }, { id: 'done', kind: 'agent', name: 'Done' },
  ] } });
  assert.deepEqual(legacy.edges.map(({ from, to, outcome }) => ({ from, to, outcome })), [
    { from: 'start', to: 'review', outcome: 'success' },
    { from: 'review', to: 'done', outcome: 'approved' },
  ]);
});

test('legacy pending reply gates bind the exact source only when history and evidence agree', async () => {
  const makeSession = id => ({ id, messages: [], checks: [], events: [], workflow: normalizeWorkflow({ id, name: 'Legacy reply', nodes: [
    { id: 'draft', name: 'Draft', kind: 'agent', submissionRequirements: { success: { fields: ['message'], minReferences: 0 } } },
    { id: 'review', name: 'Review', kind: 'human' },
    { id: 'send', name: 'Send', kind: 'action', operation: 'send_external_reply', input: { connectionId: 'source', sourceNodeId: 'draft', field: 'message' } },
  ], edges: [{ from: 'draft', to: 'review', outcome: 'success' }, { from: 'review', to: 'send', outcome: 'approved' }] }) });
  const makeEngine = session => createWorkflowEngine({ state: { sessions: { [session.id]: session } }, save: async () => {}, event: () => {}, launch: () => true });
  const submitDraft = async (session, engine) => {
    await engine.start(session); await engine.pump();
    await engine.submit(session, session.flow.instance, { summary: 'Draft ready', artifacts: [], details: { message: 'Exact legacy draft' }, references: [] });
  };

  let compatible = makeSession('legacy-compatible'); let compatibleEngine = makeEngine(compatible);
  await submitDraft(compatible, compatibleEngine);
  compatible = JSON.parse(JSON.stringify(compatible)); compatibleEngine = makeEngine(compatible);
  const sourceInstance = compatible.flow.history[0].instance;
  delete compatible.flow.history[0].submission; delete compatible.flow.decisionSubmissionRef;
  delete compatible.flow.lastSubmission.instance; delete compatible.flow.evidenceTrail[0].evidence.sourceInstance;
  delete compatible.flow.previousEvidence.sourceInstance;
  await compatibleEngine.decide(compatible, { action: 'approveGate', instance: compatible.flow.instance });
  assert.equal(compatible.flow.approvedSubmission.submission.details.message, 'Exact legacy draft');
  assert.deepEqual(compatible.flow.approvedSubmission.sourceSubmissionRef, { nodeId: 'draft', instance: sourceInstance, revision: 1 });

  let stale = makeSession('legacy-stale'); let staleEngine = makeEngine(stale);
  await submitDraft(stale, staleEngine);
  stale = JSON.parse(JSON.stringify(stale)); staleEngine = makeEngine(stale);
  delete stale.flow.history[0].submission; delete stale.flow.decisionSubmissionRef;
  delete stale.flow.lastSubmission.instance; delete stale.flow.evidenceTrail[0].evidence.sourceInstance;
  delete stale.flow.previousEvidence.sourceInstance;
  stale.flow.lastSubmission.details.message = 'Unreviewed replacement';
  assert.notEqual(stale.flow.lastSubmission.details.message, stale.flow.previousEvidence.details.message);
  await assert.rejects(staleEngine.decide(stale, { action: 'approveGate', instance: stale.flow.instance }), /captured draft/);
  assert.equal(stale.flow.status, 'waiting_gate');
});

test('legacy unstructured artifact gates migrate only an exact prior run submission', async () => {
  let session = { id: 'legacy-artifact', messages: [], checks: [], events: [], workspace: { path: '/fixture' }, workflow: normalizeWorkflow({ id: 'legacy-artifact', name: 'Plan review', nodes: [
    { id: 'plan', name: 'Plan', kind: 'agent', artifact: { path: 'plan.md', headings: [] } },
    { id: 'review', name: 'Review', kind: 'human' },
  ], edges: [{ from: 'plan', to: 'review', outcome: 'success' }] }) };
  let engine = createWorkflowEngine({ state: { sessions: { 'legacy-artifact': session } }, save: async () => {}, event: () => {}, launch: () => true,
    inspectArtifact: async () => ({ text: 'Plan', sha256: 'artifact-hash' }), inspectChanges: async () => ({ digest: 'workspace-hash' }) });
  await engine.start(session); await engine.pump();
  await engine.submit(session, session.flow.instance, { summary: 'Plan for review', artifacts: ['plan.md'] });
  session = JSON.parse(JSON.stringify(session));
  engine = createWorkflowEngine({ state: { sessions: { 'legacy-artifact': session } }, save: async () => {}, event: () => {}, launch: () => true,
    inspectArtifact: async () => ({ text: 'Plan', sha256: 'artifact-hash' }), inspectChanges: async () => ({ digest: 'workspace-hash' }) });
  const sourceInstance = session.flow.history[0].instance;
  delete session.flow.history[0].submission; delete session.flow.history[0].sourceEvidence;
  delete session.flow.decisionSubmissionRef; delete session.flow.lastSubmission.instance;
  delete session.flow.previousEvidence.sourceNodeId; delete session.flow.previousEvidence.sourceInstance;
  delete session.flow.evidenceTrail[0].evidence.sourceNodeId; delete session.flow.evidenceTrail[0].evidence.sourceInstance;
  await engine.decide(session, { action: 'approveGate', instance: session.flow.instance });
  assert.equal(session.flow.decisionSubmissionRef.instance, sourceInstance);
  assert.equal(session.flow.history[0].sourceEvidence.artifact.hash, 'artifact-hash');
  assert.equal(session.flow.status, 'completed');
});

test('a gate revalidates its exact source even after an intervening action records newer evidence', async () => {
  let sourceDigest = 'submitted-plan';
  const session = { id: 'revision-guard', messages: [], checks: [], events: [], workspace: { path: '/fixture' }, workflow: normalizeWorkflow({ id: 'revision-guard', name: 'Plan then inspect', nodes: [
    { id: 'plan', name: 'Plan', kind: 'agent', artifact: { path: 'plan.md', headings: [] } },
    { id: 'inspect', name: 'Inspect changes', kind: 'action', operation: 'inspect_changes' },
    { id: 'review', name: 'Review', kind: 'human' },
  ], edges: [{ from: 'plan', to: 'inspect', outcome: 'success' }, { from: 'inspect', to: 'review', outcome: 'success' }] }) };
  const engine = createWorkflowEngine({ state: { sessions: { 'revision-guard': session } }, save: async () => {}, event: () => {},
    inspectArtifact: async () => ({ text: 'Plan', sha256: 'artifact-hash' }),
    inspectChanges: async (_s, artifactPath) => ({ digest: artifactPath ? sourceDigest : 'current-workspace' }),
    launch: () => true });
  await engine.start(session); await engine.pump();
  await engine.submit(session, session.flow.instance, { summary: 'Plan is ready.', artifacts: ['plan.md'] });
  await engine.pump();
  await engine.finishAutomated(session, session.flow.instance, 'success', { inspected: true });
  assert.equal(session.flow.status, 'waiting_gate');
  sourceDigest = 'changed-plan';
  await assert.rejects(engine.decide(session, { action: 'approveGate', instance: session.flow.instance }), /Submitted evidence changed/);
  assert.equal(session.flow.status, 'waiting_gate');
});
