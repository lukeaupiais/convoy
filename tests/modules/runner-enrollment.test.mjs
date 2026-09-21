import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

function fixture() {
  let clock = new Date('2026-09-20T12:00:00.000Z');
  const project = {
    id: 'project-a',
    organizationId: 'org-a',
    placement: { mode: 'none' },
    executionProfile: 'ask',
    revision: 1,
  };
  const state = {
    sessions: {},
    runners: [],
    projects: [project],
    tickets: [],
    environmentAccessBindings: [],
  };
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
    execute: async () => {
      throw new Error(
        'Enrollment must not use host credentials or probe through a managed adapter.',
      );
    },
  });
  return {
    execution,
    state,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

test('a scoped enrollment token is single-use and creates a bounded machine identity', async () => {
  const { execution, state } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Remote fleet',
    kind: 'ssh',
    host: 'fleet',
  });
  const pool = await execution.command({
    action: 'saveRunnerPool',
    organizationId: 'org-a',
    name: 'Remote pool',
    runnerIds: [],
  });
  const issued = await execution.enrollment.issue({
    organizationId: 'org-a',
    environmentId: environment.id,
    poolIds: [pool.id],
    projectIds: ['project-a'],
    authorityCeiling: 'contained',
    expectedPlatform: { platform: 'linux', architecture: 'x64' },
    expiresInSeconds: 60,
  });

  assert.equal(typeof issued.token, 'string');
  assert.equal(issued.enrollment.state, 'pending');
  assert.equal('tokenDigest' in issued.enrollment, false);
  assert.equal(JSON.stringify(execution.snapshot()).includes(issued.token), false);

  await assert.rejects(
    execution.enrollment.redeem({
      token: issued.token,
      organizationId: 'org-b',
      environmentId: environment.id,
      name: 'Wrong tenant runner',
      repository: '/repo',
      accessMode: 'contained',
      attestation: { platform: 'linux', architecture: 'x64', tools: ['read_file'] },
    }),
    /enrollment token/i,
  );

  const redeemed = await execution.enrollment.redeem({
    token: issued.token,
    organizationId: 'org-a',
    environmentId: environment.id,
    name: 'Enrolled runner',
    repository: '/repo',
    accessMode: 'contained',
    attestation: { platform: 'linux', architecture: 'x64', tools: ['read_file'] },
  });

  assert.equal(redeemed.runner.organizationId, 'org-a');
  assert.deepEqual(redeemed.runner.projectIds, ['project-a']);
  assert.equal(redeemed.runner.registration, 'outbound');
  assert.equal(redeemed.runner.machineIdentity.state, 'active');
  assert.equal(redeemed.runner.machineIdentity.organizationId, 'org-a');
  assert.match(redeemed.machineCredential, /^rnr_/);
  assert.equal('credentialDigest' in redeemed.runner.machineIdentity, false);
  assert.equal(JSON.stringify(execution.snapshot()).includes(redeemed.machineCredential), false);
  const authenticated = execution.enrollment.authenticate(redeemed.machineCredential, {
    organizationId: 'org-a',
    runnerId: redeemed.runner.id,
    environmentId: environment.id,
  });
  assert.equal(authenticated.principal.runnerId, redeemed.runner.id);
  assert.equal(state.runnerPools[0].runnerIds.includes(redeemed.runner.id), true);
  assert.equal(execution.enrollment.get(issued.enrollment.id, 'org-a').state, 'consumed');

  await assert.rejects(
    execution.enrollment.redeem({
      token: issued.token,
      organizationId: 'org-a',
      environmentId: environment.id,
      name: 'Replay runner',
      repository: '/repo',
      accessMode: 'contained',
      attestation: { platform: 'linux', architecture: 'x64', tools: ['read_file'] },
    }),
    /enrollment token/i,
  );
});

test('machine credentials rotate secret-once and revoke fail closed', async () => {
  const { execution } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Remote fleet',
    kind: 'ssh',
    host: 'fleet',
  });
  const issued = await execution.enrollment.issue({
    organizationId: 'org-a',
    environmentId: environment.id,
    projectIds: ['project-a'],
  });
  const redeemed = await execution.enrollment.redeem({
    token: issued.token,
    organizationId: 'org-a',
    environmentId: environment.id,
    name: 'Enrolled runner',
    repository: '/repo',
    attestation: { platform: 'linux', architecture: 'x64', tools: [] },
  });

  const rotated = await execution.enrollment.rotateIdentity(
    redeemed.runner.id,
    'org-a',
    redeemed.runner.machineIdentity.revision,
  );
  assert.match(rotated.machineCredential, /^rnr_/);
  assert.notEqual(rotated.machineCredential, redeemed.machineCredential);
  assert.throws(() => execution.enrollment.authenticate(redeemed.machineCredential), /invalid/i);
  assert.equal(
    execution.enrollment.authenticate(rotated.machineCredential).principal.runnerId,
    redeemed.runner.id,
  );

  await execution.enrollment.revokeIdentity(
    redeemed.runner.id,
    'org-a',
    rotated.machineIdentity.revision,
  );
  assert.throws(() => execution.enrollment.authenticate(rotated.machineCredential), /invalid/i);
});

test('expired or over-authority enrollment attempts fail closed without a runner', async () => {
  const { execution, state, advance } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Remote fleet',
    kind: 'ssh',
    host: 'fleet',
  });
  const issued = await execution.enrollment.issue({
    organizationId: 'org-a',
    environmentId: environment.id,
    projectIds: ['project-a'],
    authorityCeiling: 'contained',
    expiresInSeconds: 30,
  });

  await assert.rejects(
    execution.enrollment.redeem({
      token: issued.token,
      organizationId: 'org-a',
      environmentId: environment.id,
      name: 'Trusted runner',
      repository: '/repo',
      accessMode: 'trusted',
      attestation: { platform: 'linux', architecture: 'x64', tools: [] },
    }),
    /authority ceiling/i,
  );
  assert.equal(state.runners.length, 0);

  advance(31_000);
  await assert.rejects(
    execution.enrollment.redeem({
      token: issued.token,
      organizationId: 'org-a',
      environmentId: environment.id,
      name: 'Late runner',
      repository: '/repo',
      accessMode: 'contained',
      attestation: { platform: 'linux', architecture: 'x64', tools: [] },
    }),
    /expired/i,
  );
  assert.equal(execution.enrollment.get(issued.enrollment.id, 'org-a').state, 'expired');
  assert.equal(state.runners.length, 0);
});
