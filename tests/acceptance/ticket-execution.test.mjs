import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read) {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
async function fixture(t) {
  const prompts = [];
  const options = {
    directory: await mkdtemp(join(tmpdir(), 'convoy-ticket-run-')),
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fake', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      prompts.push(input);
      const submit = input.prompt?.turnInstructions.includes('Current workflow step') ?? input.systemPrompt.includes('Current workflow step');
      yield {
        type: 'result',
        message: {
          role: 'assistant',
          stopReason: submit ? 'toolUse' : 'stop',
          timestamp: Date.now(),
          content: submit
            ? [
                {
                  type: 'toolCall',
                  id: 'submit-' + prompts.length,
                  name: 'submit_step',
                  arguments: { summary: 'Implemented and verified fixture work', artifacts: [] },
                },
              ]
            : [{ type: 'text', text: 'Remembered the design decision' }],
        },
      };
    },
    runners: {
      execute: async (_runner, c) =>
        c.action === 'probe'
          ? { repository: '/fixture', tools: ['read_file', 'shell'], shell: true }
          : c.action === 'provision'
            ? { path: '/fixture/work', branch: 'fixture-work' }
            : c.action === 'diff'
              ? { digest: 'unchanged', status: ' M app.txt', diff: 'fixture diff' }
              : { code: 0, output: 'checks passed' },
    },
  };
  let runtime = await createRuntime(options);
  t.after(() => runtime.close());
  const act = (action, input = {}) =>
    runtime.command({ action, client: 'ticket-test-client', ...input });
  await act('saveWorkflow', {
    workflow: {
      id: 'ticket-loop',
      name: 'Implement and review',
      schemaVersion: 3,
      entryNode: 'work',
      maxRevisions: 2,
      nodes: [
        {
          id: 'work',
          kind: 'agent',
          name: 'Implement',
          prompt: 'Implement the ticket. Submit results.',
        },
        { id: 'review', kind: 'human', name: 'Review', prompt: 'Review the result.' },
      ],
      edges: [
        { from: 'work', to: 'review', outcome: 'success' },
        { from: 'review', to: 'work', outcome: 'changes_requested' },
      ],
    },
  });
  const ticket = await act('createTicket', {
    requestId: 'ticket',
    projectId: 'agent-platform',
    title: 'Implement search',
    description: 'Respect the accessible keyboard design.',
  });
  const launch = {
    ticketId: ticket.id,
    revision: ticket.revision,
    mode: 'new',
    workflowId: 'ticket-loop',
    workflowVersion: 1,
    model: 'fixture',
    placement: { mode: 'none' },
    requestId: 'launch',
  };
  return {
    act,
    ticket,
    launch,
    prompts,
    snapshot: () => runtime.snapshot(),
    restart: async () => {
      await runtime.close();
      runtime = await createRuntime(options);
    },
  };
}
test('ticket run: execute, revise, approve, then explicitly complete ticket without moving local board', async (t) => {
  const f = await fixture(t);
  const board = await f.act('saveBoard', {
    name: 'Independent',
    projectIds: [],
    grouping: { mode: 'local' },
    columns: [
      { id: 'todo', name: 'To do' },
      { id: 'done', name: 'Done' },
    ],
  });
  const run = await f.act('runTicket', f.launch);
  const session = async () => (await f.snapshot()).sessions.find((s) => s.id === run.sessionId);
  let gate = await until(async () => {
    const s = await session();
    return s.flow?.status === 'waiting_gate' && s;
  });
  const identity = gate.currentAgentSessionId;
  await f.act('requestChanges', {
    sessionId: run.sessionId,
    instance: gate.flow.instance,
    feedback: 'Add keyboard focus handling',
  });
  gate = await until(async () => {
    const s = await session();
    return s.flow?.status === 'waiting_gate' && s.flow.revision === 1 && s;
  });
  assert.equal(gate.currentAgentSessionId, identity);
  assert.equal(gate.flow.lastSubmission.summary, 'Implemented and verified fixture work');
  await f.act('approveGate', { sessionId: run.sessionId, instance: gate.flow.instance });
  let state = await f.snapshot();
  assert.equal((await session()).flow.status, 'completed');
  assert.equal(state.tickets[0].status, 'Backlog');
  await f.act('updateTicket', {
    taskId: f.ticket.id,
    revision: state.tickets[0].revision,
    patch: { status: 'Done' },
  });
  state = await f.snapshot();
  assert.equal(state.tickets[0].status, 'Done');
  assert.equal(state.boards.find((b) => b.id === board.id).tickets[0].columnId, 'todo');
});
test('ticket run: continue preserves prior conversation context and pinned workflow; retry survives restart', async (t) => {
  const f = await fixture(t);
  const chat = await f.act('createConversation', {
    requestId: 'plan',
    projectId: 'agent-platform',
  });
  await f.act('claim', { sessionId: chat.sessionId });
  await f.act('start', {
    sessionId: chat.sessionId,
    text: 'Preserve this architecture decision',
    model: 'fixture',
    requestId: 'plan-turn',
  });
  await until(async () => {
    const s = (await f.snapshot()).sessions.find((s) => s.id === chat.sessionId);
    return s?.status === 'awaiting_review' && !s.control.busy;
  });
  const input = { ...f.launch, mode: 'continue', sessionId: chat.sessionId };
  const first = await f.act('runTicket', input);
  assert.equal(first.sessionId, chat.sessionId);
  await until(
    async () =>
      (await f.snapshot()).sessions.find((s) => s.id === chat.sessionId)?.flow?.status ===
      'waiting_gate',
  );
  assert.match(JSON.stringify(f.prompts.at(-1).prompt.messages), /Preserve this architecture decision/);
  await f.act('saveWorkflow', {
    workflow: {
      id: 'ticket-loop',
      name: 'New version',
      steps: [{ id: 'gate', kind: 'human', name: 'Other', prompt: 'Other' }],
    },
  });
  assert.equal(
    (await f.snapshot()).sessions.find((s) => s.id === chat.sessionId).workflow.version,
    1,
  );
  await f.restart();
  const retry = await f.act('runTicket', input);
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal((await f.snapshot()).sessions.length, 1);
});
test('ticket run: validation and foreign controller prevent side effects', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.act('runTicket', { ...f.launch, revision: 0 }), /changed/);
  await assert.rejects(
    f.act('runTicket', { ...f.launch, workflowVersion: 999 }),
    /Workflow is not available for this project\./,
  );
  await assert.rejects(f.act('runTicket', { ...f.launch, model: 'missing' }), /model/);
  const c = await f.act('createConversation', { requestId: 'owned', projectId: 'agent-platform' });
  await f.act('claim', {
    sessionId: c.sessionId,
    client: 'other-controller',
    label: 'Native terminal',
  });
  await assert.rejects(
    f.act('runTicket', { ...f.launch, mode: 'continue', sessionId: c.sessionId }),
    /controlled/,
  );
  const state = await f.snapshot();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.tickets[0].revision, f.ticket.revision);
  assert.equal(f.prompts.length, 0);
});
test('ticket run: status values do not define whether a workflow may start', async (t) => {
  const f = await fixture(t);
  const updated = await f.act('updateTicket', {
    taskId: f.ticket.id,
    revision: f.ticket.revision,
    patch: { status: 'Done' },
  });
  const run = await f.act('runTicket', {
    ...f.launch,
    revision: updated.revision,
    requestId: 'run-with-project-status',
  });
  assert.equal(run.ticketId, f.ticket.id);
});
test('ticket run: active run cannot be replaced or started twice', async (t) => {
  const f = await fixture(t);
  const one = await f.act('runTicket', f.launch);
  const retry = await f.act('runTicket', f.launch);
  assert.equal(one.sessionId, retry.sessionId);
  const state = await f.snapshot();
  await assert.rejects(
    f.act('runTicket', { ...f.launch, requestId: 'another', revision: state.tickets[0].revision }),
    /Finish|cancel/,
  );
  assert.equal((await f.snapshot()).sessions.length, 1);
});
test('ticket run: durable ticket attachments are exposed in snapshots and supplied to the agent', async (t) => {
  const f = await fixture(t);
  const content = 'TICKET_ATTACHMENT_CONTENT';
  const attached = await f.act('attachTicketFile', {
    taskId: f.ticket.id,
    revision: f.ticket.revision,
    name: 'scope.md',
    mime: 'text/plain',
    data: Buffer.from(content).toString('base64'),
  });
  assert.equal(attached.attachments[0].name, 'scope.md');
  assert.ok(!JSON.stringify(await f.snapshot()).includes(content));
  const stored = await f.snapshot();
  assert.equal(stored.tickets[0].attachments.length, 1);
  await f.restart();
  const run = await f.act('runTicket', {
    ...f.launch,
    revision: attached.revision,
    requestId: 'attachment-run',
  });
  assert.equal(run.ticketId, f.ticket.id);
  await until(() => f.prompts.length);
  assert.match(JSON.stringify(f.prompts[0].prompt.messages), /TICKET_ATTACHMENT_CONTENT/);
});
test('ticket run: local runner provisions, evidence is inspectable, worktree cannot be relocated', async (t) => {
  const f = await fixture(t);
  await f.act('registerRunner', { name: 'Local fixture', kind: 'local', repository: '/fixture' });
  const runner = (await f.snapshot()).runners[0];
  const run = await f.act('runTicket', {
    ...f.launch,
    placement: { mode: 'pinned', runnerId: runner.id },
  });
  const gate = await until(async () => {
    const s = (await f.snapshot()).sessions.find((s) => s.id === run.sessionId);
    return !s.control.busy && s.flow?.status === 'waiting_gate' && s;
  });
  assert.equal(gate.workspace.path, '/fixture/work');
  await f.act('diff', { sessionId: run.sessionId });
  assert.equal((await f.snapshot()).sessions[0].review.diff, 'fixture diff');
  await f.act('approveGate', { sessionId: run.sessionId, instance: gate.flow.instance });
  const state = await f.snapshot();
  await assert.rejects(
    f.act('runTicket', {
      ...f.launch,
      requestId: 'relocate',
      revision: state.tickets[0].revision,
      mode: 'continue',
      sessionId: run.sessionId,
    }),
    /fixed/,
  );
});
