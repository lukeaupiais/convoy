import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function until(read) {
  for (let index = 0; index < 300; index++) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Acceptance condition did not become true.');
}

test('workflow Work actions cannot cross projects or disclose a foreign idempotent create result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-work-boundary-'));
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Work-only activities must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('Work-only activities must not start a runner.'); }, close: async () => {} },
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}) => runtime.command({ action, client: 'workflow-work-boundary', ...input });

  const firstOrganization = await act('createOrganization', { slug: 'work-owner', displayName: 'Work owner', kind: 'team' });
  const foreignOrganization = await act('createOrganization', { slug: 'work-foreign', displayName: 'Foreign work', kind: 'team' });
  const ownerProject = await act('saveProject', { organizationId: firstOrganization.id, name: 'Run project' });
  const foreignProject = await act('saveProject', { organizationId: foreignOrganization.id, name: 'Foreign project' });
  await act('selectActiveContext', { context: { organizationId: foreignOrganization.id, projectId: foreignProject.id } });
  const foreignTicket = await act('createTicket', { requestId: 'foreign-existing-request', projectId: foreignProject.id, title: 'Foreign original', status: 'Backlog' });
  await act('selectActiveContext', { context: { organizationId: firstOrganization.id, projectId: ownerProject.id } });

  async function rejectedRun(id, node) {
    await act('saveWorkflow', { projectId: ownerProject.id, workflow: { id, name: id, nodes: [node], edges: [] } });
    const { workflowRunId } = await act('startWorkflowRun', { projectId: ownerProject.id, workflowId: id, workflowVersion: 1 });
    return until(async () => {
      const run = await act('getWorkflowRun', { workflowRunId });
      if (run.status === 'failed') return run;
      return null;
    });
  }

  const foreignCreate = await rejectedRun('foreign-create-attempt', {
    id: 'create', kind: 'action', name: 'Create foreign ticket', operation: 'create_ticket',
    input: { projectId: foreignProject.id, requestKey: 'cross-project-create', title: 'Must not exist' },
  });
  assert.equal(foreignCreate.status, 'failed');
  const leakedRequest = await rejectedRun('foreign-request-replay', {
    id: 'create', kind: 'action', name: 'Replay foreign request', operation: 'create_ticket',
    input: { projectId: ownerProject.id, requestKey: 'foreign-existing-request', title: 'Must not be disclosed' },
  });
  assert.equal(leakedRequest.status, 'failed');
  const foreignUpdate = await rejectedRun('foreign-update-attempt', {
    id: 'update', kind: 'action', name: 'Update foreign ticket', operation: 'update_ticket',
    input: { ticketId: foreignTicket.id, patch: { title: 'Must not change' } },
  });
  assert.equal(foreignUpdate.status, 'failed');

  await act('saveWorkflow', { projectId: ownerProject.id, workflow: { id: 'owner-project-default', name: 'Owner project default', nodes: [
    { id: 'create', kind: 'action', name: 'Create in owner project', operation: 'create_ticket', input: { requestKey: 'owner-project-create', title: 'Owner project ticket' } },
  ], edges: [] } });
  const { workflowRunId } = await act('startWorkflowRun', { projectId: ownerProject.id, workflowId: 'owner-project-default', workflowVersion: 1 });
  const completed = await until(async () => {
    const run = await act('getWorkflowRun', { workflowRunId });
    return run.status === 'completed' ? run : null;
  });
  assert.equal(completed.status, 'completed');

  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const savedForeign = state.tickets.find(ticket => ticket.id === foreignTicket.id);
  assert.equal(savedForeign.projectId, foreignProject.id);
  assert.equal(savedForeign.title, 'Foreign original');
  assert.equal(savedForeign.status, 'Backlog');
  assert.equal(state.tickets.some(ticket => ticket.title === 'Must not exist'), false);
  assert.equal(state.ticketRequests['cross-project-create'], undefined);
  assert.equal(state.ticketRequests['foreign-existing-request'], foreignTicket.id);
  const ownerTicket = state.tickets.find(ticket => ticket.title === 'Owner project ticket');
  assert.equal(ownerTicket.projectId, ownerProject.id);
  assert.equal(state.ticketRequests['owner-project-create'], ownerTicket.id);
  assert.equal(Object.keys(state.sessions).length, 0);
});
