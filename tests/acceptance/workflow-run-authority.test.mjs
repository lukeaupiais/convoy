import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-run-authority-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Human-only runs must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('Human-only runs must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}, principal) => runtime.command({ action, client: 'shared-client', ...input }, principal);
  const org = await act('createOrganization', { slug: 'review-authority', displayName: 'Review authority', kind: 'team' });
  const otherOrg = await act('createOrganization', { slug: 'other-authority', displayName: 'Other authority', kind: 'team' });
  const project = await act('saveProject', { organizationId: org.id, name: 'Publication' });
  const otherProject = await act('saveProject', { organizationId: otherOrg.id, name: 'Procurement' });
  await act('selectActiveContext', { context: { organizationId: org.id, projectId: project.id } });
  await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'publication-review', name: 'Publication review', nodes: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Review the material.' }], edges: [],
  } });
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const id of ['reviewer-a', 'reviewer-b', 'outsider']) state.identity.users.push({ id, displayName: id, state: 'active', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(state));
  runtime = await createRuntime(options);
  const principals = Object.fromEntries(['reviewer-a', 'reviewer-b', 'outsider'].map(id => [id, { kind: 'user', userId: id }]));
  for (const [id, principal] of Object.entries(principals)) {
    const targetOrg = id === 'outsider' ? otherOrg : org;
    const targetProject = id === 'outsider' ? otherProject : project;
    await act('createMembership', { organizationId: targetOrg.id, principal, scope: { kind: 'organization', organizationId: targetOrg.id }, roles: ['member'] });
    await act('createMembership', { organizationId: targetOrg.id, principal, scope: { kind: 'project', projectId: targetProject.id }, roles: ['contributor'] });
    await act('selectActiveContext', { context: { organizationId: targetOrg.id, projectId: targetProject.id } }, principal);
  }
  return { act, project, principals, snapshot: principal => runtime.snapshot(undefined, 'shared-client', principal), restart: async () => { await runtime.close(); runtime = await createRuntime(options); }, stored: async () => JSON.parse(await readFile(statePath, 'utf8')) };
}

test('standalone run controls bind actor and exact attempt, invalidate on restart, and retain the decision actor', async t => {
  const f = await fixture(t);
  const a = f.principals['reviewer-a'];
  const b = f.principals['reviewer-b'];
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: 'publication-review', workflowVersion: 1 }, a);
  const before = await f.snapshot(a);
  const run = before.workflowRuns.find(value => value.id === workflowRunId);
  assert.equal(run.status, 'waiting_gate');
  assert.equal(before.sessions.length, 0);
  await f.act('selectActiveContext', { context: { organizationId: run.organizationId, projectId: f.project.id } });
  await f.act('saveWorkflow', { projectId: f.project.id, workflow: { id: 'publication-review', name: 'New publication policy', nodes: [{ id: 'different-review', kind: 'human', name: 'Different review', prompt: 'Use the new policy.' }], edges: [] } });
  assert.equal((await f.snapshot(a)).workflowRuns.find(value => value.id === workflowRunId).workflowVersion, 1);
  await f.act('claimWorkflowRun', { workflowRunId }, a);
  await assert.rejects(f.act('claimWorkflowRun', { workflowRunId }, b), /another client|controlled/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, b), /control|claim/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId, instance: 'stale-attempt', decision: 'approve' }, a), /changed|stale/i);
  assert.equal((await f.snapshot(a)).workflowRuns.find(value => value.id === workflowRunId).status, 'waiting_gate');
  await f.restart();
  await f.act('selectActiveContext', { context: { organizationId: run.organizationId, projectId: f.project.id } }, a);
  await f.act('selectActiveContext', { context: { organizationId: run.organizationId, projectId: f.project.id } }, b);
  const recovered = (await f.snapshot(a)).workflowRuns.find(value => value.id === workflowRunId);
  assert.equal(recovered.instance, run.instance);
  assert.equal(recovered.nodeId, 'review');
  assert.equal(recovered.workflowVersion, 1);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, a), /control|claim/i);
  await f.act('claimWorkflowRun', { workflowRunId }, b);
  await f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, b);
  assert.equal((await f.snapshot(b)).workflowRuns.find(value => value.id === workflowRunId).status, 'completed');
  const stored = await f.stored();
  assert.equal(stored.workflowRuns[workflowRunId].events.find(value => value.type === 'gate_approved').actor, 'reviewer-b');
  assert.equal(Object.keys(stored.sessions).length, 0);
});

test('standalone run tenancy comes from authoritative project and run, including snapshots', async t => {
  const f = await fixture(t);
  const a = f.principals['reviewer-a'];
  const outsider = f.principals.outsider;
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: 'publication-review', workflowVersion: 1 }, a);
  const run = (await f.snapshot(a)).workflowRuns.find(value => value.id === workflowRunId);
  await assert.rejects(f.act('startWorkflowRun', { projectId: f.project.id, workflowId: 'publication-review', workflowVersion: 1 }, outsider), /authorized|available|active/i);
  const exact = await f.act('getWorkflowRun', { workflowRunId }, a);
  assert.equal(exact.id, workflowRunId);
  assert.equal(exact.instance, run.instance);
  assert.equal('principal' in exact, false);
  assert.equal('messages' in exact, false);
  await assert.rejects(f.act('getWorkflowRun', { workflowRunId }, outsider), /authorized|available|active/i);
  await assert.rejects(f.act('claimWorkflowRun', { workflowRunId }, outsider), /authorized|available|active/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, outsider), /authorized|available|active/i);
  assert.equal((await f.snapshot(outsider)).workflowRuns.some(value => value.id === workflowRunId), false);
  assert.equal((await f.snapshot(a)).workflowRuns.find(value => value.id === workflowRunId).status, 'waiting_gate');
});

test('run detail projects lease control for the authenticated actor as well as the shared client', async t => {
  const f = await fixture(t);
  const a = f.principals['reviewer-a'];
  const b = f.principals['reviewer-b'];
  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.project.id,
    workflowId: 'publication-review',
    workflowVersion: 1,
  }, a);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const { workflowRunId: laterRunId } = await f.act('startWorkflowRun', {
    projectId: f.project.id,
    workflowId: 'publication-review',
    workflowVersion: 1,
  }, a);
  await f.act('claimWorkflowRun', { workflowRunId }, a);

  const owned = await f.act('getWorkflowRun', { workflowRunId }, a);
  const otherActor = await f.act('getWorkflowRun', { workflowRunId }, b);
  assert.equal(owned.lease.ownedByCurrentCaller, true);
  assert.equal(otherActor.lease.ownedByCurrentCaller, false);
  assert.equal(owned.lease.principalKey, undefined);
  assert.equal(otherActor.lease.principalKey, undefined);

  const snapshot = await f.snapshot(a);
  const leasedSnapshotIndex = snapshot.workflowRuns.findIndex((run) => run.id === workflowRunId);
  const leasedSnapshotRun = snapshot.workflowRuns[leasedSnapshotIndex];
  assert.ok(snapshot.workflowRuns.some((run) => run.id === laterRunId));
  assert.ok(leasedSnapshotRun);
  assert.ok(leasedSnapshotIndex > 0);
  assert.equal('ownedByCurrentCaller' in leasedSnapshotRun.lease, false);
});

test('run decisions retain the exact governed workload principal rather than its kind alone', async t => {
  const f = await fixture(t);
  const sample = await f.snapshot(f.principals['reviewer-a']);
  const project = sample.projects.find(value => value.id === f.project.id);
  await f.act('selectActiveContext', { context: { organizationId: project.organizationId, projectId: project.id } });
  const workload = await f.act('createWorkloadIdentity', { organizationId: project.organizationId, displayName: 'Configured review automation' });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', { organizationId: project.organizationId, principal, scope: { kind: 'organization', organizationId: project.organizationId }, roles: ['member'] });
  await f.act('createMembership', { organizationId: project.organizationId, principal, scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await f.act('selectActiveContext', { context: { organizationId: project.organizationId, projectId: project.id } }, principal);
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: 'publication-review', workflowVersion: 1 }, principal);
  const run = await f.act('getWorkflowRun', { workflowRunId }, principal);
  await f.act('claimWorkflowRun', { workflowRunId }, principal);
  await f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, principal);
  const stored = await f.stored();
  assert.deepEqual(stored.workflowRuns[workflowRunId].events.find(value => value.type === 'gate_approved').principal, principal);
  assert.deepEqual(stored.workflowRuns[workflowRunId].decisions[0].principal, principal);
  assert.equal(stored.workflowRuns[workflowRunId].decisions[0].instance, run.instance);
});

test('revoking a standalone run principal prevents a later Work mutation even when another reviewer can access the run', async t => {
  const f = await fixture(t);
  const a = f.principals['reviewer-a'];
  const b = f.principals['reviewer-b'];
  const before = await f.snapshot(a);
  const project = before.projects.find(value => value.id === f.project.id);
  const membership = before.memberships.find(value => value.scope.kind === 'project' && value.scope.projectId === project.id);
  await f.act('selectActiveContext', { context: { organizationId: project.organizationId, projectId: project.id } });
  const ticket = await f.act('createTicket', { requestId: 'revoked-run-target', projectId: project.id, title: 'Configured procurement action' });
  await f.act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'governed-record', name: 'Governed record', nodes: [
      { id: 'review', kind: 'human', name: 'Review', prompt: 'Review request.' },
      { id: 'record', kind: 'action', name: 'Record', operation: 'update_ticket', input: { ticketSource: 'active_ticket', patch: { status: 'Authorized' } } },
    ], edges: [{ from: 'review', to: 'record', outcome: 'approved' }],
  } });
  const { workflowRunId } = await f.act('startWorkflowRun', { projectId: project.id, workflowId: 'governed-record', workflowVersion: 1, activeTicketId: ticket.id }, a);
  const run = await f.act('getWorkflowRun', { workflowRunId }, b);
  await f.act('updateMembership', { organizationId: project.organizationId, membershipId: membership.id, state: 'revoked' });
  await f.act('claimWorkflowRun', { workflowRunId }, b);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId, instance: run.instance, decision: 'approve' }, b), /authorized|active|available/i);
  const after = await f.snapshot(b);
  assert.notEqual(after.tickets.find(value => value.id === ticket.id).status, 'Authorized');
  assert.equal(after.sessions.length, 0);
});
