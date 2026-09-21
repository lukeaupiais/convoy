import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

test('enrolled runner channels reject expiry, revocation and cross-tenant substitution', async () => {
  let clock = new Date('2026-09-20T12:00:00.000Z');
  const project = {
    id: 'project-a',
    organizationId: 'org-a',
    executionProfile: 'ask',
    revision: 1,
  };
  const state = { sessions: {}, runners: [], projects: [project], tickets: [] };
  const execution = createExecution({
    state,
    catalog: {
      project(id) {
        if (id !== project.id) throw new Error('Project not found.');
        return project;
      },
      ticket: () => undefined,
      assertEditable: () => {},
    },
    workExecution: { hasFixedWork: () => false, clearPlacement: () => {} },
    event: () => {},
    save: async () => {},
    now: () => clock,
  });
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Fleet',
    kind: 'ssh',
    host: 'fleet',
  });
  const enrollment = await execution.enrollment.issue({
    organizationId: 'org-a',
    environmentId: environment.id,
    projectIds: ['project-a'],
  });
  const redeemed = await execution.enrollment.redeem({
    token: enrollment.token,
    organizationId: 'org-a',
    environmentId: environment.id,
    name: 'Runner',
    repository: '/repo',
    attestation: { platform: 'linux', architecture: 'x64', tools: [] },
  });
  const session = {
    id: 'chat-22222222-2222-2222-2222-222222222222',
    projectId: 'project-a',
    runnerId: redeemed.runner.id,
    workspace: { path: '/work/a', branch: 'work' },
    lease: { id: 'lease-a', client: 'cli', label: 'CLI', expiresAt: clock.getTime() + 90_000 },
    executionGrant: { digest: 'digest-a' },
    assignment: {
      environmentId: environment.id,
      policyDigest: 'digest-a',
      state: 'assigned',
    },
  };
  state.sessions[session.id] = session;
  const issued = await execution.channelGrants.issue({
    actor: { kind: 'user', userId: 'user-a' },
    session,
    audience: 'direct-channel',
    expiresInSeconds: 30,
  });
  const exact = {
    audience: 'direct-channel',
    organizationId: 'org-a',
    projectId: 'project-a',
    sessionId: session.id,
    runnerId: redeemed.runner.id,
    environmentId: environment.id,
    workspace: '/work/a',
    leaseId: 'lease-a',
    executionGrantDigest: 'digest-a',
  };
  assert.equal(
    execution.runnerChannels.validate({
      machineCredential: redeemed.machineCredential,
      channelToken: issued.token,
      expected: exact,
    }).grant.id,
    issued.grant.id,
  );
  assert.throws(
    () =>
      execution.runnerChannels.validate({
        machineCredential: redeemed.machineCredential,
        channelToken: issued.token,
        expected: { ...exact, organizationId: 'org-b' },
      }),
    /invalid/i,
  );
  await execution.channelGrants.revoke(issued.grant.id, 'org-a', issued.grant.revision, {
    kind: 'user',
    userId: 'user-a',
  });
  assert.throws(
    () =>
      execution.runnerChannels.validate({
        machineCredential: redeemed.machineCredential,
        channelToken: issued.token,
        expected: exact,
      }),
    /invalid/i,
  );

  const expiring = await execution.channelGrants.issue({
    actor: { kind: 'user', userId: 'user-a' },
    session,
    audience: 'direct-channel',
    expiresInSeconds: 30,
  });
  clock = new Date(clock.getTime() + 31_000);
  assert.throws(
    () =>
      execution.runnerChannels.validate({
        machineCredential: redeemed.machineCredential,
        channelToken: expiring.token,
        expected: exact,
      }),
    /expired/i,
  );
});
