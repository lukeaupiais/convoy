import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';
import { createRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';

test('session-backed result reads and control remain bound to the authenticated actor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-session-result-authority-'));
  const activity = {
    ref: { id: 'inventory.session-count', revision: 1 },
    inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resources: { location: 'daemon' }, effect: 'pure', approval: { required: false }, cancellation: 'immediate',
    confirmation: 'result', reconciliation: 'none', presentation: { label: 'Count inventory' },
  };
  const options = {
    directory, models: [{ id: 'fixture' }],
    workflowActivities: [{ descriptor: activity, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) { return { state: 'completed', output: structuredClone(input) }; },
    } }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A data-only workflow must not invoke a provider.'); },
    runners: { execute: async () => assert.fail('A data-only workflow must not acquire a runner.'), close: async () => {} },
  };
  const persistence = await createPersistence({ directory, initialState: initialControlPlaneState() });
  let runtime = await createRuntime({ persistence, ...options });
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const client = 'shared-browser-client';
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const organization = await act('createOrganization', { slug: `session-result-${Date.now()}`, displayName: 'Session result', kind: 'team' });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Inventory workspace' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const workflow = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'session-inventory-result', name: 'Session inventory result', projectId: project.id,
    runInputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resultBindings: { count: { from: { kind: 'activity_output', nodeId: 'count', path: ['count'] } } },
    nodes: [{ id: 'count', name: 'Count inventory', kind: 'action', activity: activity.ref,
      bindings: { count: { literal: 73 } } }], edges: [],
  } });

  const first = { kind: 'user', userId: 'session-result-owner' };
  const second = { kind: 'user', userId: 'session-result-other' };
  const timestamp = new Date().toISOString();
  persistence.store.data.identity.users.push(...[first, second].map(principal => ({ id: principal.userId,
    displayName: principal.userId, state: 'active', revision: 1, createdAt: timestamp, updatedAt: timestamp })));
  await persistence.store.save();
  await act('createMembership', { organizationId: organization.id, principal: first,
    scope: { kind: 'organization', organizationId: organization.id }, roles: ['member'] });
  await act('createMembership', { organizationId: organization.id, principal: second,
    scope: { kind: 'organization', organizationId: organization.id }, roles: ['member'] });
  const firstProjectMembership = await act('createMembership', { organizationId: organization.id, principal: first,
    scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await act('createMembership', { organizationId: organization.id, principal: second,
    scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } }, first);
  const conversation = await act('createConversation', { requestId: 'session-result-conversation', projectId: project.id }, first);
  await act('claim', { sessionId: conversation.sessionId }, first);
  await act('configure', { sessionId: conversation.sessionId, workflow: workflow.id }, first);
  await act('startWorkflow', { sessionId: conversation.sessionId }, first);

  const deadline = Date.now() + 8000;
  let session;
  while (Date.now() < deadline) {
    session = (await runtime.snapshot(conversation.sessionId, client, first)).sessions.find(value => value.id === conversation.sessionId);
    if (['completed', 'failed'].includes(session?.flow?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(session?.flow?.status, 'completed', JSON.stringify(session?.flow));
  const workflowRunId = session.flow.id;
  assert.equal(session.lease.actorKey, undefined, 'session snapshots do not disclose the private lease principal key');
  assert.equal(persistence.store.data.sessions[conversation.sessionId].lease.actorKey,
    'user:session-result-owner', 'the stored lease is bound to the authenticated principal');
  assert.equal((await act('getWorkflowRun', { workflowRunId }, first)).workflowRunResultEligible, true);
  assert.deepEqual((await act('getWorkflowRunResult', { workflowRunId }, first)).result, { count: 73 });

  session = (await runtime.snapshot(conversation.sessionId, client, first)).sessions.find(value => value.id === conversation.sessionId);
  const beforeForeignControl = session.lease.expiresAt;
  const foreignRead = await act('getWorkflowRun', { workflowRunId }, second);
  assert.equal(foreignRead.workflowRunResultEligible, false);
  await assert.rejects(act('claim', { sessionId: conversation.sessionId }, second), /stored execution principal|controlled/i);
  await assert.rejects(act('release', { sessionId: conversation.sessionId }, second), /another authenticated principal/i);
  await assert.rejects(act('getWorkflowRunResult', { workflowRunId }, second), /stored principal|authenticated principal/i);
  const afterForeignControl = persistence.store.data.sessions[conversation.sessionId].lease;
  assert.equal(afterForeignControl.expiresAt, beforeForeignControl, 'rejected foreign control does not renew or replace the owner lease');

  const liveUnboundLease = persistence.store.data.sessions[conversation.sessionId].lease;
  delete liveUnboundLease.actorKey;
  await persistence.store.save();
  const legacyLeaseRead = await act('getWorkflowRun', { workflowRunId }, first);
  assert.equal(legacyLeaseRead.workflowRunResultEligible, false, 'a legacy unbound lease is not result-read authority');
  await assert.rejects(act('getWorkflowRunResult', { workflowRunId }, first), /stored principal|authenticated principal/i);
  const unboundBeforeControl = structuredClone(persistence.store.data.sessions[conversation.sessionId].lease);
  for (const principal of [first, second]) {
    await assert.rejects(act('release', { sessionId: conversation.sessionId }, principal), /authenticated principal/i);
    await assert.rejects(act('heartbeat', { sessionId: conversation.sessionId }, principal), /authenticated principal/i);
  }
  const unboundAfterControl = persistence.store.data.sessions[conversation.sessionId].lease;
  assert.equal(unboundAfterControl.actorKey, undefined);
  assert.equal(unboundAfterControl.expiresAt, unboundBeforeControl.expiresAt,
    'neither the prior owner nor another actor can renew/release an unbound legacy lease');
  await act('claim', { sessionId: conversation.sessionId }, first);
  assert.deepEqual((await act('getWorkflowRunResult', { workflowRunId }, first)).result, { count: 73 },
    'the stored workflow principal can explicitly rebind legacy session control');
  await act('updateMembership', { organizationId: organization.id, membershipId: firstProjectMembership.id, roles: ['viewer'] });
  assert.equal((await act('getWorkflowRun', { workflowRunId }, first)).workflowRunResultEligible, false,
    'session-bound control does not replace current project.execute authority');
  await assert.rejects(act('getWorkflowRunResult', { workflowRunId }, first), /permission|authorized/i);
});
