import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read, predicate) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for workflow recovery.');
}

test('uncertain workflow board effects are not replayed on restart and require explicit recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-recovery-')); let mode = 'fail'; let calls = 0;
  const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () {}, boards: { command: async command => { if (command.action === 'createTicket') { calls++; if (mode === 'fail') throw new Error('Board unavailable.'); return { id: 99, title: 'Recovered' }; } return {}; } } };
  let runtime = await createRuntime(options); const act = (action, input = {}) => runtime.command({ action, client: 'recovery-client', ...input });
  const chat = await act('createConversation', { requestId: 'recovery-chat' }); const scope = { sessionId: chat.sessionId }; await act('claim', scope);
  await act('saveWorkflow', { workflow: { id: 'effect', name: 'Effect', nodes: [{ id: 'create', kind: 'action', name: 'Create ticket', operation: 'create_ticket', input: { title: 'Recovered', projectId: 'agent-platform' } }] } });
  await act('configure', { ...scope, workflow: 'effect' }); await act('startWorkflow', scope);
  let snapshot = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'failed');
  const failed = snapshot.sessions[0]; const effectKey = `${failed.flow.id}:${failed.flow.instance}:create`;
  assert.equal(calls, 1); assert.equal(snapshot.workflowEffects.find(effect => effect.effectKey === effectKey).status, 'uncertain');
  await runtime.close(); runtime = await createRuntime(options); snapshot = await runtime.snapshot(); assert.equal(calls, 1);
  const resumed = snapshot.sessions[0]; await runtime.command({ action: 'claim', sessionId: resumed.id, client: 'recovery-client' });
  await assert.rejects(runtime.command({ action: 'reconcileWorkflowEffect', sessionId: resumed.id, client: 'recovery-client', instance: 'stale', effectKey, resolution: 'not_applied' }), /changed|instance/i);
  mode = 'success'; await runtime.command({ action: 'reconcileWorkflowEffect', sessionId: resumed.id, client: 'recovery-client', instance: resumed.flow.instance, effectKey, resolution: 'not_applied' });
  await runtime.command({ action: 'heartbeat', sessionId: resumed.id, client: 'recovery-client' }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal((await runtime.snapshot()).sessions[0].flow.status, 'paused'); assert.equal(calls, 1);
  await runtime.close(); runtime = await createRuntime(options); const paused = (await runtime.snapshot()).sessions[0]; assert.equal(paused.flow.status, 'paused'); assert.equal(calls, 1); await runtime.command({ action: 'claim', sessionId: paused.id, client: 'recovery-client' }); await runtime.command({ action: 'continueWorkflow', sessionId: paused.id, client: 'recovery-client', instance: paused.flow.instance });
  await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'completed'); assert.equal(calls, 2); await runtime.close();
});

test('applied reconciliation accepts only an existing ticket result and never replays the effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-applied-')); let calls = 0;
  const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () {}, boards: { command: async command => { if (command.action === 'createTicket') { calls++; throw new Error('Connection lost after the board write.'); } return {}; } } };
  let runtime = await createRuntime(options); const act = (action, input = {}) => runtime.command({ action, client: 'applied-client', ...input });
  const chat = await act('createConversation', { requestId: 'applied-chat' }); const scope = { sessionId: chat.sessionId }; await act('claim', scope);
  await act('saveWorkflow', { workflow: { id: 'applied-effect', name: 'Applied effect', nodes: [{ id: 'create', kind: 'action', name: 'Create ticket', operation: 'create_ticket', input: { title: 'Persisted result', projectId: 'agent-platform' } }] } });
  await act('configure', { ...scope, workflow: 'applied-effect' }); await act('startWorkflow', scope);
  const failed = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'failed'); const sessionId = failed.sessions[0].id; const instance = failed.sessions[0].flow.instance; const effectKey = `${failed.sessions[0].flow.id}:${instance}:create`;
  await runtime.close(); const statePath = join(directory, 'state.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.tickets.push({ id: 99, projectId: 'agent-platform', title: 'Persisted result', description: '', status: 'Backlog', label: 'Core', agent: 'Unassigned', priority: 'Medium', revision: 1, placement: { mode: 'inherit' }, createdAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(state)); runtime = await createRuntime(options); await runtime.command({ action: 'claim', sessionId, client: 'applied-client' });
  await assert.rejects(runtime.command({ action: 'reconcileWorkflowEffect', sessionId, client: 'applied-client', instance, effectKey, resolution: 'applied', result: { id: 100 } }), /existing ticket/i);
  await runtime.command({ action: 'reconcileWorkflowEffect', sessionId, client: 'applied-client', instance, effectKey, resolution: 'applied', result: { id: 99, title: 'Persisted result' } });
  const completed = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'completed'); assert.equal(calls, 1); assert.equal(completed.tickets.find(ticket => ticket.id === 99).title, 'Persisted result'); await runtime.close();
});

test('failed board trigger can be retried with its pinned version without replaying the move', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-trigger-retry-'));
  const runners = { execute: async (_runner, command) => command.action === 'probe' ? { repository: '/fixture', tools: [], shell: false } : command.action === 'provision' ? { path: '/fixture/recovered', branch: 'recovered' } : command.action === 'diff' ? { digest: 'same' } : {} };
  const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () {}, runners };
  let runtime = await createRuntime(options); const act = (action, input = {}) => runtime.command({ action, client: 'trigger-retry-client', ...input });
  const ticket = await act('createTicket', { requestId: 'retry-ticket', projectId: 'agent-platform', title: 'Retry trigger' }); const board = await act('saveBoard', { name: 'Retry board', projectIds: ['agent-platform'], columns: [{ id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' }] });
  const workflow = { id: 'retry-workflow', name: 'Inspect v1', nodes: [{ id: 'inspect', kind: 'action', name: 'Inspect v1', operation: 'inspect_changes' }], triggers: [{ event: 'ticket_moved', boardId: board.id, columnId: 'review' }] }; await act('saveWorkflow', { workflow });
  await act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { name: 'Inspect review', projectId: 'agent-platform', event: 'ticket_moved', boardId: board.id, columnId: 'review', workflowId: workflow.id, workflowVersion: 1, enabled: true } });
  let snapshot = await act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } }).then(() => runtime.snapshot());
  const failed = snapshot.workflowTriggers.find(trigger => trigger.workflowId === workflow.id); assert.equal(failed.status, 'failed'); assert.equal(failed.workflowVersion, 1); const moveRevision = snapshot.tickets.find(value => value.id === ticket.id).revision;
  await act('saveWorkflow', { workflow: { ...workflow, name: 'Inspect v2', nodes: [{ ...workflow.nodes[0], name: 'Inspect v2' }] }, baseVersion: 1 }); await act('registerRunner', { name: 'Recovery runner', kind: 'local', repository: '/fixture' });
  const runnerId = (await runtime.snapshot()).runners[0].id; const statePath = join(directory, 'state.json'); await runtime.close(); const state = JSON.parse(await readFile(statePath, 'utf8')); state.sessions[String(ticket.id)].placement = { mode: 'pinned', runnerId }; await writeFile(statePath, JSON.stringify(state)); runtime = await createRuntime(options);
  const retrySession = (await runtime.snapshot()).sessions.find(session => session.id === String(ticket.id)); await runtime.command({ action: 'claim', taskId: String(ticket.id), client: 'trigger-retry-client' }); await runtime.command({ action: 'retryWorkflowTrigger', taskId: String(ticket.id), client: 'trigger-retry-client', triggerKey: failed.triggerKey });
  const completed = await until(() => runtime.snapshot(), value => value.sessions.find(session => session.id === retrySession.id)?.flow?.status === 'completed'); const result = completed.sessions.find(session => session.id === retrySession.id); assert.equal(result.workflow.nodes[0].name, 'Inspect v1'); assert.equal(completed.tickets.find(value => value.id === ticket.id).revision, moveRevision); await runtime.close();
});

test('agent-created tickets use the board trigger seam, while denied creation has no side effect', async () => {
  let turn = 0;
  const options = { directory: await mkdtemp(join(tmpdir(), 'convoy-agent-trigger-')), models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {
      if (turn++ === 0) yield { type: 'result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'create-ticket', name: 'create_ticket', arguments: { requestKey: 'agent-ticket', projectId: 'agent-platform', title: 'Agent-created', description: 'Trigger me' } }], stopReason: 'tool', timestamp: Date.now() } };
      else yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'No operation.' }], stopReason: 'stop', timestamp: Date.now() } };
    } };
  const runtime = await createRuntime(options); const act = (action, input = {}) => runtime.command({ action, client: 'agent-trigger-client', ...input });
  const chat = await act('createConversation', { requestId: 'agent-trigger-chat' }); await act('claim', { sessionId: chat.sessionId });
  await act('saveWorkflow', { workflow: { id: 'created-trigger', name: 'Created ticket gate', nodes: [{ id: 'gate', kind: 'human', name: 'Gate', prompt: 'Review created ticket' }], triggers: [{ event: 'ticket_created', projectId: 'agent-platform' }] } });
  await act('saveWorkflowStartRule', { organizationId: 'personal', revision: 0, rule: { name: 'Created ticket gate', projectId: 'agent-platform', event: 'ticket_created', workflowId: 'created-trigger', workflowVersion: 1, enabled: true } });
  await act('start', { sessionId: chat.sessionId, model: 'fixture', text: 'Record this work', requestId: 'agent-create-run' });
  const pending = await until(() => runtime.snapshot(chat.sessionId), value => value.sessions[0]?.pending); await act('decide', { sessionId: chat.sessionId, approvalId: pending.sessions[0].pending.id, allow: true });
  const createdSnapshot = await until(() => runtime.snapshot(), value => value.tickets.find(ticket => ticket.title === 'Agent-created')); const created = createdSnapshot.tickets.find(ticket => ticket.title === 'Agent-created');
  await until(() => runtime.snapshot(), value => value.sessions.find(session => session.id === String(created.id))?.flow?.status === 'waiting_gate');
  const snapshot = await runtime.snapshot(); const triggeredSession = snapshot.sessions.find(session => session.id === String(created.id)); assert.equal(triggeredSession.workflow.id, 'created-trigger'); assert.equal(snapshot.workflowTriggers.filter(value => value.workflowId === 'created-trigger').length, 1);
  await runtime.close();

  const deniedOptions = { ...options, directory: await mkdtemp(join(tmpdir(), 'convoy-agent-denied-')), generate: async function* () { yield { type: 'result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'denied-ticket', name: 'create_ticket', arguments: { requestKey: 'denied', projectId: 'agent-platform', title: 'Should not exist', description: 'Denied' } }], stopReason: 'tool', timestamp: Date.now() } }; } };
  const deniedRuntime = await createRuntime(deniedOptions); const denied = (action, input = {}) => deniedRuntime.command({ action, client: 'denied-client', ...input }); const deniedChat = await denied('createConversation', { requestId: 'denied-chat' }); await denied('claim', { sessionId: deniedChat.sessionId }); await denied('start', { sessionId: deniedChat.sessionId, model: 'fixture', text: 'Do not record', requestId: 'denied-run' });
  const deniedPending = await until(() => deniedRuntime.snapshot(deniedChat.sessionId), value => value.sessions[0]?.pending); await denied('decide', { sessionId: deniedChat.sessionId, approvalId: deniedPending.sessions[0].pending.id, allow: false }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal((await deniedRuntime.snapshot()).tickets.some(ticket => ticket.title === 'Should not exist'), false); await deniedRuntime.close();
});

test('non-zero check results follow the failed graph outcome and consume a bounded revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-check-failure-'));
  const runners = { execute: async (_runner, command) => command.action === 'probe' ? { repository: '/fixture', tools: ['shell'], shell: true } : command.action === 'provision' ? { path: '/fixture/check', branch: 'check' } : command.action === 'diff' ? { digest: 'check-digest' } : { code: 1, output: 'failed', stopped: false } };
  const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () {}, runners };
  const runtime = await createRuntime(options); const act = (action, input = {}) => runtime.command({ action, taskId: '1', client: 'check-client', ...input }); await act('ensure', { title: 'Check failure' }); await act('claim', { label: 'Check' });
  await act('saveWorkflow', { workflow: { id: 'check-revision', name: 'Check revision', maxRevisions: 2, nodes: [{ id: 'check', kind: 'check', name: 'Verify', prompt: 'Run verification', checkCommand: 'npm test' }, { id: 'repair', kind: 'human', name: 'Repair review', prompt: 'Review the failed check' }], edges: [{ from: 'check', to: 'repair', outcome: 'failed' }] } });
  await act('registerRunner', { name: 'Check runner', kind: 'local', repository: '/fixture' }); const runnerId = (await runtime.snapshot()).runners[0].id; await act('configure', { runnerId, workflow: 'check-revision' }); await act('startWorkflow');
  const pending = await until(() => runtime.snapshot('1'), value => value.sessions[0]?.pending); await act('decide', { approvalId: pending.sessions[0].pending.id, allow: true });
  const waiting = await until(() => runtime.snapshot('1'), value => value.sessions[0]?.flow?.status === 'waiting_gate'); const flow = waiting.sessions[0].flow; assert.equal(flow.history[0].outcome, 'failed'); assert.equal(flow.revision, 1); assert.equal(waiting.sessions[0].status, 'waiting_gate'); await runtime.close();
});
