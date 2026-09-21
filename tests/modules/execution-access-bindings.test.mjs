import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

function fixture() {
  const projects = [
    {
      id: 'project-a',
      organizationId: 'org-a',
      placement: { mode: 'none' },
      executionProfile: 'ask',
      revision: 1,
    },
    {
      id: 'project-b',
      organizationId: 'org-b',
      placement: { mode: 'none' },
      executionProfile: 'ask',
      revision: 1,
    },
  ];
  const state = {
    sessions: {},
    runners: [],
    projects,
    tickets: [],
    environmentAccessBindings: [],
  };
  const catalog = {
    project(id) {
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error('Project not found.');
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
    execute: async (_runner, request) => ({
      repository: request.repository,
      tools: ['read_file'],
      terminal: false,
    }),
  });
  return { execution, projects, state };
}

test('placement requires an organization-scoped environment binding', async () => {
  const { execution, projects } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Organization A environment',
    kind: 'local',
  });
  const runner = await execution.command({
    action: 'registerRunner',
    organizationId: 'org-a',
    name: 'Organization A runner',
    environmentId: environment.id,
    repository: '/repo',
    projectIds: ['project-a'],
  });
  const pool = await execution.command({
    action: 'saveRunnerPool',
    organizationId: 'org-a',
    name: 'Organization A pool',
    runnerIds: [runner.id],
  });
  projects[0].placement = { mode: 'pool', poolId: pool.id };
  const session = {
    id: 'session-a',
    organizationId: 'org-a',
    projectId: 'project-a',
    placement: structuredClone(projects[0].placement),
  };

  assert.match(execution.placement.choose(session).reason, /access binding/i);

  const binding = await execution.access.saveBinding({
    organizationId: 'org-a',
    subject: { kind: 'project', projectId: 'project-a' },
    resource: { kind: 'environment', environmentId: environment.id },
    role: 'use',
  });

  assert.equal(execution.access.authorize(session, environment, 'use').allowed, true);
  assert.equal(execution.placement.choose(session).runner.id, runner.id);
  assert.equal(binding.organizationId, 'org-a');
  assert.equal(environment.organizationId, 'org-a');
  assert.equal(runner.organizationId, 'org-a');
  assert.equal(pool.organizationId, 'org-a');
});

test('environment bindings never authorize a project from another organization', async () => {
  const { execution } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Organization A environment',
    kind: 'local',
  });

  await assert.rejects(
    execution.access.saveBinding({
      organizationId: 'org-a',
      subject: { kind: 'project', projectId: 'project-b' },
      resource: { kind: 'environment', environmentId: environment.id },
      role: 'use',
    }),
    /not found/i,
  );
  assert.equal(
    execution.access.authorize(
      { organizationId: 'org-b', projectId: 'project-b' },
      environment,
      'use',
    ).allowed,
    false,
  );
});

test('environment bindings reject team and user subjects outside the organization', async () => {
  const { execution, state } = fixture();
  state.organizations = {
    teams: [
      { id: 'team-a', organizationId: 'org-a', state: 'active' },
      { id: 'team-b', organizationId: 'org-b', state: 'active' },
    ],
    memberships: [
      {
        organizationId: 'org-a',
        principal: { kind: 'user', userId: 'alice' },
        state: 'active',
      },
      {
        organizationId: 'org-b',
        principal: { kind: 'user', userId: 'bob' },
        state: 'active',
      },
    ],
  };
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Organization A environment',
    kind: 'local',
  });
  const bind = (subject) =>
    execution.access.saveBinding({
      organizationId: 'org-a',
      subject,
      resource: { kind: 'environment', environmentId: environment.id },
      role: 'use',
    });

  await assert.rejects(bind({ kind: 'team', teamId: 'team-b' }), /not found/i);
  await assert.rejects(bind({ kind: 'user', userId: 'bob' }), /not found/i);
  assert.equal((await bind({ kind: 'team', teamId: 'team-a' })).subject.teamId, 'team-a');
  assert.equal((await bind({ kind: 'user', userId: 'alice' })).subject.userId, 'alice');
});

test('runner-pool bindings constrain eligible profiles and repositories', async () => {
  const { execution, projects } = fixture();
  const environment = await execution.command({
    action: 'saveEnvironment',
    organizationId: 'org-a',
    name: 'Organization A environment',
    kind: 'local',
  });
  const runner = await execution.command({
    action: 'registerRunner',
    organizationId: 'org-a',
    name: 'Organization A runner',
    environmentId: environment.id,
    repository: '/approved/repository',
    projectIds: ['project-a'],
  });
  const pool = await execution.command({
    action: 'saveRunnerPool',
    organizationId: 'org-a',
    name: 'Organization A pool',
    runnerIds: [runner.id],
  });
  projects[0].placement = { mode: 'pool', poolId: pool.id };
  await execution.access.saveBinding({
    organizationId: 'org-a',
    subject: { kind: 'project', projectId: 'project-a' },
    resource: { kind: 'runner-pool', runnerPoolId: pool.id },
    role: 'administer',
    constraints: {
      executionProfiles: ['ask'],
      repositoryPatterns: ['/approved/*'],
    },
  });
  const session = {
    id: 'session-a',
    organizationId: 'org-a',
    projectId: 'project-a',
    placement: structuredClone(projects[0].placement),
  };

  assert.equal(execution.placement.choose(session).runner.id, runner.id);
  projects[0].executionProfile = 'auto';
  assert.match(execution.placement.choose(session).reason, /access binding/i);
});
