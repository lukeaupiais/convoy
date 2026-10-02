import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const exact = await act('getWorkflowRun', { workflowRunId }, principal);
  exact.attempt.status = 'forged';
  exact.decisions.push({ decision: 'approve', actor: 'forged' });
  const reread = await act('getWorkflowRun', { workflowRunId }, principal);
  assert.notEqual(reread.attempt.status, 'forged');
  assert.deepEqual(reread.decisions, []);
  await act('claimWorkflowRun', { workflowRunId }, principal);
  await act('revokeWorkloadIdentity', { organizationId: organization.id, workloadIdentityId: workload.id, expectedRevision: workload.revision });
  await assert.rejects(act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, principal), /not active|revoked|authorized/i);
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const snapshot = await runtime.snapshot();
  assert.equal((await act('getWorkflowRun', { workflowRunId })).status, 'interrupted');
  assert.equal(snapshot.sessions.length, 0);
  await act('claimWorkflowRun', { workflowRunId });
  await act('cancelWorkflowRun', { workflowRunId });
  assert.equal((await act('getWorkflowRun', { workflowRunId })).status, 'cancelled');
  await act('releaseWorkflowRun', { workflowRunId });
});

test('a current operator can reconcile a revoked run effect without dispatching its successor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-run-revoked-reconcile-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A no-agent run must not invoke a provider.'); },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}, principal) => runtime.command({ action, client: 'revoked-reconcile-client', ...input }, principal);
  const organization = await act('createOrganization', { slug: 'revoked-reconcile', displayName: 'Revoked reconcile', kind: 'team' });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Reconcile project' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const workload = await act('createWorkloadIdentity', { organizationId: organization.id, displayName: 'Revoked executor' });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await act('createMembership', { organizationId: organization.id, principal, scope: { kind: 'organization', organizationId: organization.id }, roles: ['member'] });
  await act('createMembership', { organizationId: organization.id, principal, scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } }, principal);
  const ticket = await act('createTicket', { requestId: 'revoked-reconcile-target', projectId: project.id, title: 'Held successor' });
  await act('saveWorkflow', { projectId: project.id, workflow: { id: 'revoked-reconcile-flow', name: 'Revoked reconcile flow', nodes: [
    { id: 'update', kind: 'action', name: 'First update', operation: 'update_ticket', input: { ticketSource: 'active_ticket', patch: { status: 'Approved' } } },
    { id: 'successor', kind: 'action', name: 'Successor update', operation: 'update_ticket', input: { ticketSource: 'active_ticket', patch: { title: 'Must stay held' } } },
  ], edges: [{ from: 'update', to: 'successor', outcome: 'success' }] } });
  const { workflowRunId } = await act('startWorkflowRun', { projectId: project.id, workflowId: 'revoked-reconcile-flow', workflowVersion: 1, activeTicketId: ticket.id }, principal);
  runtime = await (async () => {
    await runtime.close();
    const path = join(directory, 'state.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    const run = state.workflowRuns[workflowRunId];
    const instance = 'effect-outcome-uncertain';
    const effectKey = `${workflowRunId}:${instance}:update`;
    run.flow.status = 'interrupted';
    run.flow.nodeId = 'update';
    run.flow.instance = instance;
    run.attempt = { instance, nodeId: 'update', status: 'uncertain', startedAt: new Date().toISOString() };
    const savedTicket = state.tickets.find(value => value.id === ticket.id);
    savedTicket.status = 'Backlog';
    state.workflowEffectLedger[effectKey] = { at: new Date().toISOString(), status: 'uncertain', operation: 'update_ticket',
      sessionId: workflowRunId, projectId: project.id, organizationId: organization.id,
      command: { action: 'updateTicket', ticketId: ticket.id, taskId: ticket.id }, result: null };
    await writeFile(path, JSON.stringify(state));
    return createRuntime(options);
  })();
  await act('revokeWorkloadIdentity', { organizationId: organization.id, workloadIdentityId: workload.id, expectedRevision: workload.revision });
  const owner = (await act('getWorkflowRun', { workflowRunId })).principal;
  assert.deepEqual(owner, undefined);
  const current = (await act('getWorkflowRun', { workflowRunId }));
  const instance = current.instance;
  const effectKey = `${workflowRunId}:${instance}:update`;
  await act('claimWorkflowRun', { workflowRunId });
  await act('reconcileWorkflowRun', { workflowRunId, instance, effectKey, resolution: 'applied', result: { id: ticket.id, status: 'Approved' } });
  const reconciled = await act('getWorkflowRun', { workflowRunId });
  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.nodeId, 'successor');
  assert.equal(reconciled.attempt.status, 'waiting');
  assert.equal(reconciled.activityAttempts.find(attempt => attempt.instance === instance)?.status, 'completed');
  const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const savedTicket = stored.tickets.find(value => value.id === ticket.id);
  assert.equal(savedTicket.status, 'Backlog');
  assert.equal(savedTicket.title, 'Held successor');
  assert.equal((await runtime.snapshot()).sessions.length, 0);
});
