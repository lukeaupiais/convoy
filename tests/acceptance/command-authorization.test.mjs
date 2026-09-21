import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const auth = {
  token: async () => 'fixture-token',
  status: async () => ({ source: 'test', connected: true }),
};

const runners = {
  execute: async (_runner, command) =>
    command.action === 'probe'
      ? {
          repository: command.repository,
          platform: 'linux',
          arch: 'x64',
          worker: { platform: 'linux', arch: 'x64' },
          tools: [],
        }
      : {},
  close: async () => {},
};

const options = (directory) => ({
  directory,
  models: [{ id: 'fixture' }],
  generate: async function* () {},
  provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
  auth,
  runners,
});

test('authenticated commands resolve authoritative resource tenancy and reject cross-tenant mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-command-authz-'));
  let runtime = await createRuntime(options(directory));
  const local = { kind: 'user', userId: 'local' };
  const localCommand = (action, input = {}) =>
    runtime.command({ action, client: 'local-admin', ...input }, local);

  const organizationA = await localCommand('createOrganization', {
    slug: 'tenant-a',
    displayName: 'Tenant A',
    kind: 'team',
  });
  const teamA = await localCommand('createTeam', {
    organizationId: organizationA.id,
    slug: 'tenant-a-team',
    displayName: 'Tenant A team',
  });
  const projectA = await localCommand('saveProject', {
    organizationId: organizationA.id,
    name: 'Project A',
  });
  await localCommand('selectActiveContext', {
    context: { organizationId: organizationA.id, projectId: projectA.id },
  });
  const ticketA = await localCommand('createTicket', {
    requestId: 'ticket-a',
    projectId: projectA.id,
    title: 'Tenant A ticket',
  });
  const boardA = await localCommand('saveBoard', {
    name: 'Tenant A board',
    projectIds: [projectA.id],
    columns: [{ id: 'backlog', name: 'Backlog' }],
  });
  const environmentA = await localCommand('saveEnvironment', {
    organizationId: organizationA.id,
    name: 'Tenant A environment',
    kind: 'local',
  });
  const runnerA = await localCommand('registerRunner', {
    organizationId: organizationA.id,
    environmentId: environmentA.id,
    name: 'Tenant A runner',
    repository: directory,
    projectIds: [projectA.id],
  });
  const poolA = await localCommand('saveRunnerPool', {
    organizationId: organizationA.id,
    name: 'Tenant A pool',
    runnerIds: [runnerA.id],
  });

  const organizationB = await localCommand('createOrganization', {
    slug: 'tenant-b',
    displayName: 'Tenant B',
    kind: 'team',
  });
  const projectB = await localCommand('saveProject', {
    organizationId: organizationB.id,
    name: 'Project B',
  });
  await runtime.close();

  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.identity.users.push({
    id: 'bob',
    displayName: 'Bob',
    state: 'active',
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeFile(statePath, JSON.stringify(state));

  runtime = await createRuntime(options(directory));
  t.after(() => runtime.close());
  await runtime.command(
    {
      action: 'createMembership',
      client: 'local-admin',
      organizationId: organizationB.id,
      principal: { kind: 'user', userId: 'bob' },
      scope: { kind: 'organization', organizationId: organizationB.id },
      roles: ['member'],
    },
    local,
  );
  await runtime.command(
    {
      action: 'createMembership',
      client: 'local-admin',
      organizationId: organizationB.id,
      principal: { kind: 'user', userId: 'bob' },
      scope: { kind: 'project', projectId: projectB.id },
      roles: ['contributor'],
    },
    local,
  );
  await runtime.command(
    {
      action: 'selectActiveContext',
      client: 'local-admin',
      context: { organizationId: organizationB.id, projectId: projectB.id },
    },
    local,
  );
  await assert.rejects(
    runtime.command(
      {
        action: 'saveProject',
        client: 'local-admin',
        organizationId: organizationB.id,
        teamId: teamA.id,
        name: 'Cross-tenant team project',
      },
      local,
    ),
    /Not authorized/,
  );

  const bob = { kind: 'user', userId: 'bob' };
  const attack = (action, input) =>
    runtime.command(
      {
        action,
        client: 'bob-client',
        ...input,
      },
      bob,
    );
  await attack('selectActiveContext', {
    context: { organizationId: organizationB.id, projectId: projectB.id },
  });

  const attempts = [
    [
      'saveProject',
      {
        id: projectA.id,
        organizationId: organizationB.id,
        revision: projectA.revision,
        name: 'stolen',
      },
    ],
    [
      'updateTicket',
      { taskId: ticketA.id, revision: ticketA.revision, patch: { title: 'stolen' } },
    ],
    [
      'saveBoard',
      {
        id: boardA.id,
        revision: boardA.revision,
        name: 'stolen',
        projectIds: [projectB.id],
        columns: boardA.columns,
      },
    ],
    ['deleteBoard', { id: boardA.id, revision: boardA.revision }],
    ['probeRunner', { runnerId: runnerA.id }],
    [
      'saveEnvironment',
      {
        id: environmentA.id,
        organizationId: organizationB.id,
        revision: environmentA.revision,
        name: 'stolen',
        kind: 'local',
      },
    ],
    [
      'saveRunnerPool',
      {
        id: poolA.id,
        organizationId: organizationB.id,
        revision: poolA.revision,
        name: 'stolen',
        runnerIds: [],
      },
    ],
    [
      'updateRunner',
      {
        runnerId: runnerA.id,
        organizationId: organizationB.id,
        revision: runnerA.revision,
        name: 'stolen',
        maxConcurrent: 1,
        enabled: true,
        tags: [],
        projectIds: [projectB.id],
      },
    ],
    [
      'setPlacement',
      { taskId: ticketA.id, revision: ticketA.revision, placement: { mode: 'none' } },
    ],
    ['createConversation', { requestId: 'cross-tenant-chat', projectId: projectA.id }],
    ['openTicketConversation', { ticketId: ticketA.id, requestId: 'cross-tenant-ticket-chat' }],
  ];

  for (const [action, input] of attempts) {
    await assert.rejects(
      attack(action, input),
      /Not authorized|not available in the active context/,
      action,
    );
  }

  const bobConversation = await attack('createConversation', {
    requestId: 'bob-authorized-chat',
  });
  assert.equal(bobConversation.projectId, projectB.id);
  await attack('claim', { sessionId: bobConversation.sessionId });
  await assert.rejects(
    attack('linkTicket', { sessionId: bobConversation.sessionId, ticketId: ticketA.id }),
    /Not authorized/,
  );
  await assert.rejects(
    attack('configure', { sessionId: bobConversation.sessionId, runnerId: runnerA.id }),
    /Not authorized/,
  );
  await assert.rejects(
    attack('saveWorkflow', {
      workflow: {
        id: 'cross-tenant-workflow',
        name: 'Cross tenant workflow',
        nodes: [{ id: 'review', name: 'Review', kind: 'human', prompt: 'Review' }],
        edges: [],
        entryNode: 'review',
      },
    }),
    /Not authorized/,
  );
  await assert.rejects(
    attack('saveBoard', {
      name: 'Unowned board',
      projectIds: [],
      columns: [{ id: 'backlog', name: 'Backlog' }],
    }),
    /Not authorized/,
  );

  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.projects.find((project) => project.id === projectA.id).name, 'Project A');
  assert.equal(after.tickets.find((ticket) => ticket.id === ticketA.id).title, 'Tenant A ticket');
  assert.equal(
    after.environments.find((environment) => environment.id === environmentA.id).name,
    'Tenant A environment',
  );
});
