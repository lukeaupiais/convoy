import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

function fixture(accessMode = 'contained', authorizeFullSystem) {
  const project = {
    id: 'project',
    revision: 1,
    placement: { mode: 'none' },
    executionProfile: 'ask',
  };
  const state = { sessions: {}, runners: [], projects: [project], tickets: [] };
  const catalog = {
    project: (id) => {
      if (id !== project.id) throw new Error('Project not found.');
      return project;
    },
    ticket: () => undefined,
    assertEditable: () => {},
  };
  const execution = createExecution({
    state,
    catalog,
    workExecution: { hasFixedWork: () => false, clearPlacement: () => {} },
    event: () => {},
    save: async () => {},
    execute: async (_runner, request) =>
      request.action === 'probe'
        ? {
            repository: request.repository,
            tools: ['read_file', 'write_file', 'shell'],
            shell: true,
          }
        : request.action === 'provision'
          ? { path: `/repo/${request.workspaceId}`, branch: request.workspaceId }
          : undefined,
    authorizeFullSystem,
  });
  return { execution, project, state, accessMode };
}

test('execution profiles keep sandbox authority, approval and reviewer independent', async () => {
  const { execution, project } = fixture();
  assert.deepEqual(
    execution.policy.profiles().map((profile) => profile.id),
    ['plan', 'ask', 'edit', 'auto', 'dont-ask', 'full-access-ask', 'full-access', 'deny'],
  );
  await execution.command({
    action: 'setExecutionProfile',
    projectId: project.id,
    revision: project.revision,
    profile: 'auto',
  });
  const session = { id: 'chat', projectId: project.id };
  const grant = execution.policy.resolve(session);
  assert.equal(grant.envelope.isolation, 'workspace');
  assert.equal(grant.approval.reviewer, 'policy');
  assert.equal(
    execution.policy.decision(session, { name: 'shell' }, { approval: 'ask' }).decision,
    'allow',
  );
  const business = execution.policy.decision(
    session,
    { name: 'create_ticket' },
    { approval: 'ask' },
  );
  assert.equal(business.decision, 'ask');
  assert.equal(business.reviewer, 'user');
});

test('scheduler limits are owned and projected per organization', async () => {
  const { execution } = fixture();
  await execution.command({ action: 'setScheduler', organizationId: 'org-a', maxConcurrent: 2 });
  await execution.command({ action: 'setScheduler', organizationId: 'org-b', maxConcurrent: 7 });
  assert.equal(
    execution.snapshot({ scope: { organizationId: 'org-a' } }).scheduler.maxConcurrent,
    2,
  );
  assert.equal(
    execution.snapshot({ scope: { organizationId: 'org-b' } }).scheduler.maxConcurrent,
    7,
  );
  assert.equal(
    execution.snapshot({ scope: { organizationId: 'personal' } }).scheduler.maxConcurrent,
    4,
  );
});

test('organization policy denial stops full system placement before runner dispatch', async () => {
  let decisions = 0;
  const { execution, project, state } = fixture('trusted', async (_session, profileId) => {
    decisions++;
    assert.equal(profileId, 'full-access');
    return { effect: 'deny', reason: 'organization-policy' };
  });
  const runner = await execution.command({
    action: 'registerRunner',
    name: 'Trusted',
    kind: 'local',
    repository: '/repo',
    projectIds: [project.id],
    accessMode: 'trusted',
  });
  project.executionProfile = 'full-access';
  project.placement = { mode: 'pinned', runnerId: runner.id };
  const session = { id: 'denied', projectId: project.id, placement: project.placement };
  state.sessions[session.id] = session;
  const prepared = await execution.prepare(session);
  assert.match(prepared.reason, /Organization policy/);
  assert.equal(session.assignment, undefined);
  assert.equal(decisions, 1);
});

test('a full-access-ask profile does not satisfy an organization policy ask decision', async () => {
  const { execution, project, state } = fixture('trusted', async (_session, profileId) => {
    assert.equal(profileId, 'full-access-ask');
    return { effect: 'ask', reason: 'organization-policy' };
  });
  const runner = await execution.command({
    action: 'registerRunner',
    name: 'Trusted',
    kind: 'local',
    repository: '/repo',
    projectIds: [project.id],
    accessMode: 'trusted',
  });
  project.executionProfile = 'full-access-ask';
  project.placement = { mode: 'pinned', runnerId: runner.id };
  const session = { id: 'ask-denied', projectId: project.id, placement: project.placement };
  state.sessions[session.id] = session;
  const prepared = await execution.prepare(session);
  assert.match(prepared.reason, /Organization policy/);
  assert.equal(session.assignment, undefined);
});

test('host profiles require trusted runner attestation and assignments pin the grant digest', async () => {
  const { execution, project, state } = fixture();
  const contained = await execution.command({
    action: 'registerRunner',
    name: 'Contained',
    kind: 'local',
    repository: '/repo',
    projectIds: [project.id],
  });
  await execution.command({
    action: 'setExecutionProfile',
    projectId: project.id,
    revision: project.revision,
    profile: 'full-access',
  });
  assert.equal(execution.policy.supports(contained, 'full-access'), false);
  const trusted = await execution.command({
    action: 'registerRunner',
    name: 'Trusted',
    kind: 'local',
    repository: '/repo',
    projectIds: [project.id],
    accessMode: 'trusted',
  });
  assert.equal(execution.policy.supports(trusted, 'full-access'), true);
  const pool = await execution.command({
    action: 'saveRunnerPool',
    name: 'All',
    runnerIds: [contained.id, trusted.id],
  });
  project.placement = { mode: 'pool', poolId: pool.id };
  const session = {
    id: 'chat',
    projectId: project.id,
    workspace: null,
    placement: structuredClone(project.placement),
  };
  state.sessions[session.id] = session;
  const prepared = await execution.prepare(session);
  assert.ok(prepared.runner, JSON.stringify(prepared));
  assert.equal(prepared.runner.id, trusted.id);
  assert.equal(session.executionGrant.profileId, 'full-access');
  assert.equal(session.assignment.policyDigest, session.executionGrant.digest);
});

test('dont-ask preserves exact-rule eligibility without opening an interactive prompt', () => {
  const { execution, project } = fixture();
  project.executionProfile = 'dont-ask';
  const outcome = execution.policy.decision(
    { id: 'chat', projectId: project.id },
    { name: 'shell' },
    { approval: 'ask' },
  );
  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.interactive, false);
});
