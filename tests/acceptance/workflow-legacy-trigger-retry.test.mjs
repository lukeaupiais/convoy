import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read, predicate, message = 'Timed out waiting for the legacy workflow retry.') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('historical failed-before-start retry runs its immutable v1 pin once after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-legacy-trigger-retry-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Human-only retry must not invoke a provider.'); },
  };
  let runtime;
  const close = async () => {
    if (!runtime) return;
    const current = runtime;
    runtime = null;
    await current.close();
  };
  const open = async () => { runtime = await createRuntime(options); };
  const act = (action, input = {}) => runtime.command({ action, client: 'legacy-retry-client', ...input });
  t.after(async () => {
    try { await close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });

  await open();
  const board = await act('saveBoard', {
    name: 'Legacy retry fixture', projectIds: ['agent-platform'],
    columns: [{ id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' }],
  });
  const ticket = await act('createTicket', {
    requestId: 'legacy-retry-ticket', projectId: 'agent-platform', boardId: board.id, title: 'Review supplier quote',
  });
  const workflow = {
    id: 'legacy-retry-review', name: 'Legacy supplier review', nodes: [
      { id: 'review-v1', kind: 'human', name: 'V1 approval', prompt: 'Review the supplier quote.' },
    ], edges: [],
  };
  await act('saveWorkflow', { workflow, baseVersion: 0 });
  await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    id: 'legacy-retry-rule', name: 'Legacy review rule', projectId: 'agent-platform', enabled: false,
    when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: 1 },
  } });
  await act('setBoardPlacement', {
    boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'inbox' },
  });
  const inboxTicket = (await runtime.snapshot()).tickets.find(value => value.id === ticket.id);
  await act('setBoardPlacement', {
    boardId: board.id, ticketId: ticket.id, revision: inboxTicket.revision, placement: { columnId: 'review' },
  });
  const moveRevision = (await runtime.snapshot()).tickets.find(value => value.id === ticket.id).revision;
  const rule = (await runtime.snapshot()).automations.find(value => value.id === 'legacy-retry-rule');
  await act('saveAutomation', { organizationId: 'personal', revision: rule.revision, rule: {
    id: rule.id, name: rule.name, projectId: rule.projectId, enabled: true,
    when: rule.when, if: rule.if, then: rule.then,
  } });
  const conversation = await act('openTicketConversation', { ticketId: ticket.id, requestId: 'legacy-retry-conversation' });
  const foreignTicket = await act('createTicket', {
    requestId: 'legacy-retry-foreign-ticket', projectId: 'agent-platform', title: 'Different request',
  });
  const foreignConversation = await act('openTicketConversation', { ticketId: foreignTicket.id, requestId: 'legacy-retry-foreign-conversation' });

  // Seed only the old failed-before-start decision shape; board, workflow,
  // automation rule and conversations above came through public commands.
  const triggerKey = JSON.stringify(['ticket_moved', rule.id, ticket.id, moveRevision]);
  await close();
  const statePath = join(directory, 'state.json');
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  // Historical conversation linkage was recorded through the public command;
  // the older session format also stored its active ticket on the session.
  stored.sessions[conversation.sessionId].activeTicketId = ticket.id;
  stored.sessions[foreignConversation.sessionId].activeTicketId = foreignTicket.id;
  stored.automationDecisionLedger ??= {};
  stored.automationDecisionLedger[triggerKey] = {
    status: 'failed', ticketId: ticket.id, trigger: 'ticket_moved',
    ruleId: rule.id, ruleRevision: rule.revision + 1,
    organizationId: 'personal', projectId: 'agent-platform',
    workflowId: workflow.id, workflowVersion: 1,
    at: new Date().toISOString(), message: 'Workflow failed before start.',
  };
  await writeFile(statePath, JSON.stringify(stored));
  await open();

  const failed = () => runtime.snapshot().then(snapshot => snapshot.automationDecisions.find(value => value.triggerKey === triggerKey));
  assert.equal((await failed()).status, 'failed');
  await act('saveWorkflow', {
    workflow: { ...workflow, name: 'Current supplier review', nodes: [
      { id: 'review-v2', kind: 'human', name: 'V2 approval', prompt: 'Review the current supplier policy.' },
    ] }, baseVersion: 1,
  });
  const definitions = (await runtime.snapshot()).workflows.filter(value => value.id === workflow.id);
  assert.equal(definitions.find(value => value.version === 1).nodes[0].name, 'V1 approval');
  assert.equal(definitions.find(value => value.version === 2).nodes[0].name, 'V2 approval');
  assert.equal((await runtime.snapshot()).tickets.find(value => value.id === ticket.id).revision, moveRevision);

  await assert.rejects(act('retryAutomationDecision', { sessionId: conversation.sessionId, triggerKey }), /claim|control|lease/i,
    'restart invalidates the old session lease before retry');
  assert.equal((await failed()).status, 'failed');
  await act('claim', { sessionId: foreignConversation.sessionId });
  await assert.rejects(act('retryAutomationDecision', { sessionId: foreignConversation.sessionId, triggerKey }), /another ticket/i,
    'a failed decision cannot be retried from a different active ticket');
  assert.equal((await failed()).status, 'failed');
  await act('claim', { sessionId: conversation.sessionId });
  await act('retryAutomationDecision', { sessionId: conversation.sessionId, triggerKey });

  const started = await until(() => runtime.snapshot(), snapshot =>
    snapshot.sessions.find(value => value.id === conversation.sessionId)?.flow?.status === 'waiting_gate');
  const retried = started.sessions.find(value => value.id === conversation.sessionId);
  assert.equal(retried.flow.workflowId, workflow.id);
  assert.equal(retried.flow.workflowVersion, 1, 'retry executes the version recorded by the legacy decision, not current v2');
  assert.equal(retried.flow.nodeId, 'review-v1');
  assert.equal(started.automationDecisions.find(value => value.triggerKey === triggerKey).status, 'started');
  assert.equal(started.automationDecisions.find(value => value.triggerKey === triggerKey).attempts, 1);
  assert.equal(started.tickets.find(value => value.id === ticket.id).revision, moveRevision,
    'retry does not move or otherwise mutate its original ticket');
  assert.equal(started.workflowRuns.filter(value => value.id === retried.flow.id && value.workflowId === workflow.id).length, 1,
    'the owning run ledger contains exactly one run for the retried workflow and flow identity');
  assert.equal(started.workflowEventDecisions.items.some(value => value.runId === retried.flow.id), false,
    'the compatibility retry creates no second event-owned run');

  await close();
  await open();
  const recovered = await runtime.snapshot();
  const same = recovered.sessions.find(value => value.id === conversation.sessionId);
  assert.equal(same.flow.status, 'waiting_gate');
  assert.equal(same.flow.id, retried.flow.id);
  assert.equal(same.flow.workflowVersion, 1);
  assert.equal(same.events.filter(value => value.type === 'workflow_trigger_retry' && value.triggerKey === triggerKey).length, 1);
  assert.equal(recovered.automationDecisions.filter(value => value.triggerKey === triggerKey).length, 1);
  assert.equal(recovered.automationDecisions.find(value => value.triggerKey === triggerKey).attempts, 1);
  assert.equal(recovered.workflowRuns.filter(value => value.id === same.flow.id && value.workflowId === workflow.id).length, 1,
    'restart does not duplicate the canonical workflow run');
  assert.equal(recovered.tickets.find(value => value.id === ticket.id).revision, moveRevision);
});
