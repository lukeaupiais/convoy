import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read, message = 'Acceptance condition did not become true') {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-legacy-event-waits-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Legacy event waits must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('Legacy event waits must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, input = {}) => runtime.command({ action, client: 'legacy-event-waits-test', ...input });
  const project = await act('saveProject', { name: 'Event wait compatibility' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  return {
    directory,
    act,
    project,
    runtime: () => runtime,
    async restart(mutateState) {
      await runtime.close();
      runtime = null;
      if (mutateState) {
        const path = join(directory, 'state.json');
        const state = JSON.parse(await readFile(path, 'utf8'));
        mutateState(state);
        await writeFile(path, JSON.stringify(state));
      }
      runtime = await createRuntime(options);
      await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    },
  };
}

async function startLegacyWait(f, activeTicket, waitFor, id) {
  const workflow = await f.act('saveWorkflow', {
    projectId: f.project.id,
    workflow: {
      id,
      name: `Wait for ${id}`,
      nodes: [{ id: 'wait', kind: 'wait', name: 'Wait for ticket update', waitFor }],
      edges: [],
    },
  });
  const started = await f.act('startWorkflowRun', {
    projectId: f.project.id,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    activeTicketId: activeTicket.id,
  });
  await until(async () => {
    const run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    return run?.status === 'waiting_event' ? run : null;
  }, 'Legacy wait did not become active');
  return { workflow, runId: started.workflowRunId };
}

async function updateStatus(f, ticket, status) {
  const updated = await f.act('updateTicket', {
    taskId: ticket.id,
    revision: ticket.revision,
    patch: { status },
  });
  await f.runtime().tickWorkflowEvents();
  return updated;
}

async function status(f, runId) {
  return (await f.act('getWorkflowRun', { workflowRunId: runId })).status;
}

async function currentTicket(f, id) {
  return (await f.runtime().snapshot()).tickets.find(ticket => ticket.id === id);
}

test('active-ticket legacy wait matches only its ticket and configured status across restart', async t => {
  const f = await fixture(t);
  const active = await f.act('createTicket', {
    requestId: 'active-wait-ticket', projectId: f.project.id, title: 'Current publication', status: 'Review',
  });
  const unrelated = await f.act('createTicket', {
    requestId: 'unrelated-wait-ticket', projectId: f.project.id, title: 'Another publication', status: 'Review',
  });
  const { runId } = await startLegacyWait(f, active, {
    event: 'ticket_updated', ticketSource: 'active_ticket', status: 'Released',
  }, 'active-ticket-wait');

  const updatedUnrelated = await updateStatus(f, unrelated, 'Released');
  assert.equal(await status(f, runId), 'waiting_event', 'a matching status on another ticket must not satisfy the wait');
  const updatedWrongStatus = await updateStatus(f, active, 'In progress');
  assert.equal(await status(f, runId), 'waiting_event', 'the active ticket with another status must not satisfy the wait');

  await f.restart(state => {
    const run = state.workflowRuns[runId];
    delete run.workflow.nodes[0].waitFor.eventRevision;
  });
  assert.equal(await status(f, runId), 'waiting_event', 'restart preserves the pending legacy wait');
  const persisted = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  const wait = Object.values(persisted.workflowWaits).find(value => value.runId === runId);
  assert.equal(wait?.descriptor.id, 'work.ticket_updated');
  assert.equal(wait?.descriptor.revision, 1, 'the legacy node shape remains bound to its stored descriptor revision');
  assert.equal(persisted.workflowRuns[runId].workflow.nodes[0].waitFor.eventRevision, undefined,
    'the decoder must not rewrite the legacy pinned workflow bytes');

  const completedTicket = await currentTicket(f, active.id);
  const exact = await updateStatus(f, completedTicket, 'Released');
  assert.equal(exact.status, 'Released');
  assert.equal(await status(f, runId), 'completed', 'the exact active ticket and configured status satisfy the wait');
  assert.equal((await f.runtime().snapshot()).sessions.length, 0);
  assert.equal(updatedUnrelated.status, 'Released');
  assert.equal(updatedWrongStatus.status, 'In progress');
});

test('related-ticket legacy wait requires the configured relation, source, and status', async t => {
  const f = await fixture(t);
  const source = await f.act('createTicket', {
    requestId: 'related-wait-source', projectId: f.project.id, title: 'Source publication', status: 'Review',
  });
  const otherSource = await f.act('createTicket', {
    requestId: 'related-wait-other-source', projectId: f.project.id, title: 'Other source', status: 'Review',
  });
  const expected = await f.act('createRelatedTicket', {
    requestId: 'related-wait-expected', sourceTicketId: source.id, sourceRevision: source.revision,
    title: 'Expected document', kind: 'fulfills',
  });
  const wrongKind = await f.act('createRelatedTicket', {
    requestId: 'related-wait-wrong-kind', sourceTicketId: source.id, sourceRevision: source.revision,
    title: 'Different relationship', kind: 'blocks',
  });
  const otherRelated = await f.act('createRelatedTicket', {
    requestId: 'related-wait-other-source-target', sourceTicketId: otherSource.id, sourceRevision: otherSource.revision,
    title: 'Other source document', kind: 'fulfills',
  });
  const unlinked = await f.act('createTicket', {
    requestId: 'related-wait-unlinked', projectId: f.project.id, title: 'Unlinked document', status: 'Review',
  });
  const { runId } = await startLegacyWait(f, source, {
    event: 'ticket_updated', ticketSource: 'related_ticket', relationKind: 'fulfills', status: 'Released',
  }, 'related-ticket-wait');

  const updatedUnlinked = await updateStatus(f, unlinked, 'Released');
  assert.equal(await status(f, runId), 'waiting_event', 'an unlinked ticket cannot satisfy the wait');
  const updatedWrongKind = await updateStatus(f, wrongKind, 'Released');
  assert.equal(await status(f, runId), 'waiting_event', 'a different relation kind cannot satisfy the wait');
  const updatedOtherSource = await updateStatus(f, otherRelated, 'Released');
  assert.equal(await status(f, runId), 'waiting_event', 'a matching relation from another source ticket cannot satisfy the wait');
  const updatedExpectedWrongStatus = await updateStatus(f, expected, 'In progress');
  assert.equal(await status(f, runId), 'waiting_event', 'the related ticket must also have the configured status');

  await f.restart();
  assert.equal(await status(f, runId), 'waiting_event', 'pending related-ticket wait survives restart');
  const currentExpected = await currentTicket(f, expected.id);
  const exact = await updateStatus(f, currentExpected, 'Released');
  assert.equal(exact.status, 'Released');
  assert.equal(await status(f, runId), 'completed', 'only the exact linked target satisfies the wait');
  assert.equal((await f.runtime().snapshot()).sessions.length, 0);
  assert.equal(updatedUnlinked.status, 'Released');
  assert.equal(updatedWrongKind.status, 'Released');
  assert.equal(updatedOtherSource.status, 'Released');
  assert.equal(updatedExpectedWrongStatus.status, 'In progress');
});
