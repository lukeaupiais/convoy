import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

test('revoking a standalone run principal blocks its pending decision and downstream Work action', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-run-revocation-'));
  const runtimeOptions = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A human-only run must not start a provider.'); },
    runners: { execute: async () => { assert.fail('A no-agent run must not start a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(runtimeOptions);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}, principal) => runtime.command({ action, client: 'run-revocation-client', ...input }, principal);
  const organization = await act('createOrganization', { slug: 'revocation-tests', displayName: 'Revocation tests', kind: 'team' });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Review project' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const workload = await act('createWorkloadIdentity', { organizationId: organization.id, displayName: 'Workflow principal' });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await act('createMembership', { organizationId: organization.id, principal, scope: { kind: 'organization', organizationId: organization.id }, roles: ['member'] });
  await act('createMembership', { organizationId: organization.id, principal, scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } }, principal);
  const ticket = await act('createTicket', { requestId: 'revocation-target', projectId: project.id, title: 'Do not update after revocation' });
  await act('saveWorkflow', { projectId: project.id, workflow: { id: 'revocation-review', name: 'Revocation review', nodes: [
    { id: 'review', kind: 'human', name: 'Review', prompt: 'Authorize the ticket update.' },
    { id: 'update', kind: 'action', name: 'Update ticket', operation: 'update_ticket', input: { ticketSource: 'active_ticket', patch: { status: 'Approved' } } },
  ], edges: [{ from: 'review', to: 'update', outcome: 'approved' }] } });
  const { workflowRunId } = await act('startWorkflowRun', { projectId: project.id, workflowId: 'revocation-review', workflowVersion: 1, activeTicketId: ticket.id }, principal);
  const run = (await runtime.snapshot(undefined, 'run-revocation-client', principal)).workflowRuns.find(value => value.id === workflowRunId);
  assert.equal(run.status, 'waiting_gate');
  await act('claimWorkflowRun', { workflowRunId }, principal);
  await act('revokeWorkloadIdentity', { organizationId: organization.id, workloadIdentityId: workload.id, expectedRevision: workload.revision });
  await assert.rejects(act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, principal), /not active|revoked|authorized/i);
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const snapshot = await runtime.snapshot();
  assert.equal((await act('getWorkflowRun', { workflowRunId })).status, 'interrupted');
  assert.equal(snapshot.sessions.length, 0);
});
