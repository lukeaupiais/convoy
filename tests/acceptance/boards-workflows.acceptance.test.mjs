import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { normalizeWorkflow, createWorkflowEngine } from '../../apps/daemon/src/modules/workflows/workflows.mjs';

async function until(read) {
  for (let i = 0; i < 300; i++) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Acceptance condition did not become true');
}

async function fixture(t) {
  const options = {
    directory: await mkdtemp(join(tmpdir(), 'convoy-independent-acceptance-')),
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { throw new Error('Acceptance fixture must not invoke an agent'); },
  };
  let runtime = await createRuntime(options);
  t.after(() => runtime.close());
  return {
    act: (action, input = {}) => runtime.command({ action, client: 'acceptance-client', ...input }),
    snapshot: () => runtime.snapshot(),
    restart: async () => { await runtime.close(); runtime = await createRuntime(options); },
    restartLegacy: async mutate => {
      await runtime.close();
      const path = join(options.directory, 'state.json');
      const state = JSON.parse(await readFile(path, 'utf8'));
      mutate(state);
      await writeFile(path, JSON.stringify(state));
      runtime = await createRuntime(options);
    },
  };
}

test('acceptance: a conversation can execute and approve a workflow without creating a ticket', async t => {
  const f = await fixture(t);
  const chat = await f.act('createConversation', { requestId: 'ticketless' });
  const scope = { sessionId: chat.sessionId };
  await f.act('claim', scope);
  await f.act('saveWorkflow', { workflow: { id: 'ticketless', name: 'Independent decision', steps: [{ id: 'decision', kind: 'human', name: 'Decide', prompt: 'Review the proposal' }] } });
  await f.act('configure', { ...scope, workflow: 'ticketless' });
  await f.act('startWorkflow', scope);
  let state = await f.snapshot();
  let session = state.sessions.find(s => s.id === chat.sessionId);
  assert.equal(state.tickets.length, 0);
  assert.equal(session.flow.status, 'waiting_gate');
  const identity = session.currentAgentSessionId;
  await f.act('approveGate', { ...scope, instance: session.flow.instance });
  await f.restart();
  state = await f.snapshot();
  session = state.sessions.find(s => s.id === chat.sessionId);
  assert.equal(session.flow.status, 'completed');
  assert.equal(session.currentAgentSessionId, identity);
  assert.equal(state.tickets.length, 0);
});

test('acceptance: board-local placement, renamed columns and active approvals remain independent across restart', async t => {
  const f = await fixture(t);
  const ticket = await f.act('createTicket', { requestId: 'shared-ticket', title: 'One ticket, two boards', projectId: 'agent-platform' });
  const make = name => f.act('saveBoard', { name, projectIds: ['agent-platform'], columns: [{ id: 'todo', name: 'To do' }, { id: 'review', name: 'Review' }], grouping: { mode: 'local' } });
  const one = await make('One');
  const two = await make('Two');
  await f.act('ensure', { taskId: String(ticket.id), title: ticket.title });
  await f.act('claim', { taskId: String(ticket.id) });
  await f.act('saveWorkflow', { workflow: { id: 'approval', name: 'Approval', steps: [{ id: 'wait', kind: 'human', name: 'Wait', prompt: 'Approve' }] } });
  await f.act('configure', { taskId: String(ticket.id), workflow: 'approval' });
  await f.act('startWorkflow', { taskId: String(ticket.id) });
  let state = await f.snapshot();
  const before = state.sessions.find(s => s.id === String(ticket.id));
  await f.act('setBoardPlacement', { boardId: one.id, ticketId: ticket.id, revision: state.tickets[0].revision, placement: { columnId: 'review' } });
  await f.act('saveBoard', { ...one, columns: [{ id: 'todo', name: 'Ideas' }, { id: 'review', name: 'Quality review' }] });
  await f.restart();
  state = await f.snapshot();
  assert.equal(state.tickets.length, 1);
  assert.equal(state.tickets[0].status, 'Backlog');
  assert.equal(state.boards.find(b => b.id === one.id).tickets.find(p => p.ticketId === ticket.id).columnId, 'review');
  assert.equal(state.boards.find(b => b.id === two.id).tickets.find(p => p.ticketId === ticket.id).columnId, 'todo');
  const after = state.sessions.find(s => s.id === String(ticket.id));
  assert.equal(after.flow.status, 'waiting_gate');
  assert.equal(after.flow.instance, before.flow.instance);
  assert.equal(after.currentAgentSessionId, before.currentAgentSessionId);
});

test('acceptance: explicit graph routes cannot silently acquire array-order connections', () => {
  const workflow = normalizeWorkflow({ id: 'reverse-order', name: 'Explicit graph', entryNode: 'start', nodes: [
    { id: 'end', kind: 'human', name: 'Final approval', prompt: 'Approve' },
    { id: 'start', kind: 'human', name: 'Initial approval', prompt: 'Approve' },
  ], edges: [{ id: 'route', from: 'start', to: 'end', outcome: 'approved' }] });
  assert.deepEqual(workflow.edges.map(({ from, to, outcome }) => ({ from, to, outcome })), [{ from: 'start', to: 'end', outcome: 'approved' }]);
  assert.throws(() => normalizeWorkflow({ id: 'disconnected', name: 'Disconnected', nodes: [
    { id: 'one', kind: 'human', name: 'One', prompt: 'Approve' },
    { id: 'two', kind: 'human', name: 'Two', prompt: 'Approve' },
  ], edges: [] }), /reachable|connect/i);
});

test('acceptance: ambiguous outcome edges are rejected at publication', () => {
  assert.throws(() => normalizeWorkflow({ id: 'ambiguous', name: 'Ambiguous', nodes: [
    { id: 'one', kind: 'agent', name: 'One', prompt: 'Produce a result' },
    { id: 'two', kind: 'human', name: 'Two', prompt: 'Approve' },
    { id: 'three', kind: 'human', name: 'Three', prompt: 'Approve' },
  ], edges: [
    { id: 'a', from: 'one', to: 'two', outcome: 'success' },
    { id: 'b', from: 'one', to: 'three', outcome: 'success' },
  ] }), /ambiguous|outcome|duplicate/i);
});

test('acceptance: a revision edge cannot disguise an unbounded alternate cycle', () => {
  assert.throws(() => normalizeWorkflow({ id: 'alternate-loop', name: 'Alternate loop', nodes: [
    { id: 'a', kind: 'human', name: 'A', prompt: 'Decide' },
    { id: 'b', kind: 'agent', name: 'B', prompt: 'Revise' },
    { id: 'c', kind: 'agent', name: 'C', prompt: 'Implement' },
  ], edges: [
    { from: 'a', to: 'b', outcome: 'changes_requested' },
    { from: 'b', to: 'c', outcome: 'success' },
    { from: 'c', to: 'a', outcome: 'success' },
    { from: 'a', to: 'c', outcome: 'approved' },
  ] }), /loop|cycle|bounded/i);
});

test('acceptance: a persisted legacy approval migrates without replacing its pending instance or session', async t => {
  const f = await fixture(t);
  const chat = await f.act('createConversation', { requestId: 'legacy-run' });
  const scope = { sessionId: chat.sessionId };
  await f.act('claim', scope);
  await f.act('saveWorkflow', { workflow: { id: 'legacy-review', name: 'Legacy review', steps: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Approve' }] } });
  await f.act('configure', { ...scope, workflow: 'legacy-review' });
  await f.act('startWorkflow', scope);
  const before = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
  await f.restartLegacy(state => {
    const session = state.sessions[chat.sessionId];
    session.workflow = { id: 'legacy-review', name: 'Legacy review', schemaVersion: 2, version: 1, steps: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Approve', phase: 'In review' }] };
    delete session.flow.nodeId;
    delete session.flow.history;
  });
  const migrated = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
  assert.equal(migrated.flow.instance, before.flow.instance);
  assert.equal(migrated.currentAgentSessionId, before.currentAgentSessionId);
  await f.act('claim', scope);
  await f.act('approveGate', { ...scope, instance: before.flow.instance });
  assert.equal((await f.snapshot()).sessions.find(s => s.id === chat.sessionId).flow.status, 'completed');
});

test('acceptance: approval rejects changed submission evidence even across an intervening branch', async () => {
  let hash = 'original';
  const session = { id: 'acceptance', messages: [], events: [], checks: [], workspace: { path: '/fixture' }, workflow: normalizeWorkflow({
    id: 'evidence', name: 'Evidence gate', nodes: [
      { id: 'work', kind: 'agent', name: 'Write brief', prompt: 'Write the brief', artifact: { path: 'brief.md', headings: ['Scope'] } },
      { id: 'route', kind: 'branch', name: 'Route review', condition: { source: 'submission', field: 'summary', exists: true } },
      { id: 'review', kind: 'human', name: 'Review', prompt: 'Approve the submitted brief' },
    ], edges: [{ from: 'work', to: 'route', outcome: 'success' }, { from: 'route', to: 'review', outcome: 'true' }, { from: 'route', to: 'review', outcome: 'false' }],
  }) };
  const engine = createWorkflowEngine({ state: { sessions: { acceptance: session } }, save: async () => {}, event: () => {}, launch: () => true,
    inspectArtifact: async () => ({ text: '# Scope\nWork', sha256: hash }), inspectChanges: async () => ({ digest: 'workspace' }),
  });
  await engine.start(session);
  await engine.pump();
  await engine.submit(session, session.flow.instance, { summary: 'Ready for review', artifacts: ['brief.md'] });
  await engine.pump();
  await engine.finishAutomated(session, session.flow.instance, 'true');
  const instance = session.flow.instance;
  hash = 'changed';
  await assert.rejects(engine.decide(session, { action: 'approveGate', instance }), /changed|evidence|submission/i);
  assert.equal(session.flow.status, 'waiting_gate');
  hash = 'original';
  await engine.decide(session, { action: 'approveGate', instance });
  assert.equal(session.flow.status, 'completed');
});

test('acceptance: shared-field WIP limits cannot be bypassed through ticket editing', async t => {
  const f = await fixture(t);
  const first = await f.act('createTicket', { requestId: 'wip-one', title: 'First', projectId: 'agent-platform', priority: 'Low' });
  const second = await f.act('createTicket', { requestId: 'wip-two', title: 'Second', projectId: 'agent-platform', priority: 'Low' });
  const board = await f.act('saveBoard', { name: 'Priority board', projectIds: ['agent-platform'], grouping: { mode: 'field', field: 'priority' }, columns: [
    { id: 'low', name: 'Low', value: 'Low' }, { id: 'high', name: 'Urgent', value: 'High', wipLimit: 1 },
  ] });
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: first.id, revision: first.revision, placement: { columnId: 'high' } });
  await assert.rejects(f.act('updateTicket', { taskId: second.id, revision: second.revision, patch: { priority: 'High' } }), /WIP|limit/i);
  const saved = (await f.snapshot()).tickets.find(t => t.id === second.id);
  assert.equal(saved.priority, 'Low');
  assert.equal(saved.revision, second.revision);
});

test('acceptance: a board move starts only the workflow version pinned by its project rule', async t => {
  const f = await fixture(t);
  const ticket = await f.act('createTicket', { requestId: 'trigger-ticket', title: 'Unassigned work', projectId: 'agent-platform' });
  const board = await f.act('saveBoard', { name: 'Trigger board', projectIds: ['agent-platform'], columns: [{ id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' }] });
  const workflow = { id: 'on-review', name: 'Review arrival', nodes: [{ id: 'gate', kind: 'human', name: 'Old review', prompt: 'Approve' }], edges: [], triggers: [{ event: 'ticket_moved', boardId: board.id, columnId: 'review' }] };
  await f.act('saveWorkflow', { workflow, baseVersion: 0 });
  await f.act('saveWorkflow', { workflow: { ...workflow, nodes: [{ ...workflow.nodes[0], name: 'Current review' }] }, baseVersion: 1 });
  await f.act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { name: 'Enter review', projectId: 'agent-platform', event: 'ticket_moved', boardId: board.id, columnId: 'review', workflowId: workflow.id, workflowVersion: 2, enabled: true } });
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } });
  const state = await f.snapshot();
  const triggered = state.sessions.filter(s => s.workflow?.id === workflow.id);
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].workflow.version, 2);
  assert.equal(triggered[0].flow.status, 'waiting_gate');
  assert.equal(state.tickets.length, 1);
  await f.restart();
  assert.equal((await f.snapshot()).sessions.filter(s => s.workflow?.id === workflow.id).length, 1);
});

test('acceptance: conflicting start rules and an active run produce durable blocked decisions', async t => {
  const f = await fixture(t);
  const ticket = await f.act('createTicket', { requestId: 'conflict-ticket', title: 'Conflict', projectId: 'agent-platform' });
  const board = await f.act('saveBoard', { name: 'Conflict board', projectIds: ['agent-platform'], columns: [{ id: 'todo', name: 'To do' }, { id: 'review', name: 'Review' }] });
  await f.act('saveWorkflow', { workflow: { id: 'conflict-review', name: 'Review', nodes: [{ id: 'gate', kind: 'human', name: 'Approve', prompt: 'Review' }] } });
  const input = { projectId: 'agent-platform', event: 'ticket_moved', boardId: board.id, columnId: 'review', workflowId: 'conflict-review', workflowVersion: 1, enabled: true };
  const first = await f.act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { ...input, name: 'First review' } });
  const second = await f.act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { ...input, name: 'Second review' } });
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } });
  let state = await f.snapshot();
  assert.deepEqual(state.workflowTriggers.map(value => value.status), ['conflict', 'conflict']);
  assert.equal(state.sessions.some(value => value.activeTicketId === ticket.id), false);
  await f.restart();
  state = await f.snapshot();
  assert.equal(state.workflowTriggers.filter(value => value.status === 'conflict').length, 2);
  await f.act('saveWorkflowStartRule', { organizationId: 'personal', revision: second.revision, rule: { ...input, id: second.id, name: second.name, enabled: false } });
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'todo' } });
  state = await f.snapshot();
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'review' } });
  state = await f.snapshot();
  assert.equal(state.workflowTriggers.findLast(value => value.ruleId === first.id).status, 'started');
  assert.equal(state.sessions.find(value => value.activeTicketId === ticket.id).flow.status, 'waiting_gate');
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'todo' } });
  state = await f.snapshot();
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'review' } });
  assert.equal((await f.snapshot()).workflowTriggers.findLast(value => value.ruleId === first.id).status, 'blocked_active');
});

test('acceptance: ticket launch and rules reject a workflow scoped to another project', async t => {
  const f = await fixture(t);
  const other = await f.act('saveProject', { name: 'Second project', organizationId: 'personal' });
  const ticket = await f.act('createTicket', { requestId: 'scoped-ticket', title: 'Scoped', projectId: 'agent-platform' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: other.id } });
  await f.act('saveWorkflow', { projectId: other.id, workflow: { id: 'second-only', name: 'Second only', nodes: [{ id: 'gate', kind: 'human', name: 'Approve', prompt: 'Review' }] } });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: 'agent-platform' } });
  await assert.rejects(f.act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { name: 'Wrong project', projectId: ticket.projectId, event: 'ticket_created', workflowId: 'second-only', workflowVersion: 1, enabled: true } }), /not available/i);
  await assert.rejects(f.act('runTicket', { requestId: 'wrong-workflow', ticketId: ticket.id, revision: ticket.revision, workflowId: 'second-only', workflowVersion: 1, model: 'fixture', mode: 'new' }), /not available/i);
});

test('acceptance: ticketless graph actions create work and route from structured results without inference', async t => {
  const f = await fixture(t);
  const chat = await f.act('createConversation', { requestId: 'action-chat' });
  const scope = { sessionId: chat.sessionId };
  await f.act('claim', scope);
  await f.act('saveWorkflow', { workflow: { id: 'record-work', name: 'Record and review', nodes: [
    { id: 'create', kind: 'action', name: 'Record work', operation: 'create_ticket', input: { title: 'Recorded by workflow', projectId: 'agent-platform' } },
    { id: 'branch', kind: 'branch', name: 'Recorded?', condition: { source: 'actionResult', field: 'id', exists: true } },
    { id: 'review', kind: 'human', name: 'Review result', prompt: 'Approve' },
    { id: 'missing', kind: 'human', name: 'Investigate missing result', prompt: 'Investigate' },
  ], edges: [
    { from: 'create', to: 'branch', outcome: 'success' }, { from: 'branch', to: 'review', outcome: 'true' }, { from: 'branch', to: 'missing', outcome: 'false' },
  ] } });
  await f.act('configure', { ...scope, workflow: 'record-work' });
  await f.act('startWorkflow', scope);
  const session = await until(async () => {
    const s = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
    if (s.flow.status === 'failed') throw new Error(JSON.stringify(s.events.slice(-3)));
    return s.flow.status === 'waiting_gate' && s;
  });
  assert.equal(session.flow.nodeId, 'review');
  assert.equal((await f.snapshot()).tickets.length, 1);
  assert.equal(session.activeTicketId, null);
  await f.restart();
  assert.equal((await f.snapshot()).tickets.length, 1);
});
