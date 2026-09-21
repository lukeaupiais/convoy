import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

const auth = {
  token: async () => 'provider-token',
  status: async () => ({ source: 'test', connected: true, device: { state: 'idle' } }),
};
const probeAdapter = (id, name = id) => ({
  protocol: 'openai-compatible',
  capabilities: ['streaming', 'tool-calls'],
  inspectConnection: async () => ({ available: true }),
  discoverModels: async () => [{ id, name, input: ['text'] }],
  async *generate() {},
});

test('remote personal bootstrap is single-use and issues a revocable device session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-remote-bootstrap-'));
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    generate: async function* () {},
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth,
    runners: { execute: async () => ({}), close: async () => {} },
    deployment: {
      id: 'dep_remote',
      displayName: 'Remote Convoy',
      issuer: 'https://convoy.example.com',
      publicOrigin: 'https://convoy.example.com',
      capabilities: [],
      authenticationMethods: ['bootstrap', 'device-session'],
    },
  });
  t.after(() => runtime.close());
  const issued = await runtime.identitySessions.bootstrap({ deviceId: 'first-device' });
  assert.equal(issued.principal.userId, 'local');
  assert.match(issued.credential, /^dvc_/);
  assert.equal(
    (await runtime.identitySessions.authenticate(issued.credential)).session.id,
    issued.session.id,
  );
  await assert.rejects(
    runtime.identitySessions.bootstrap({ deviceId: 'second-device' }),
    /already been completed/,
  );
  await runtime.identitySessions.logout(issued);
  await assert.rejects(runtime.identitySessions.authenticate(issued.credential), /not active/);
});

test('runtime switches an authorized organization context and exposes secret-free routed providers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-tenant-runtime-'));
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    generate: async function* () {},
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth,
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': () => probeAdapter('private-coder', 'Private Coder'),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
    deployment: {
      id: 'dep_test',
      displayName: 'Test Convoy',
      issuer: 'https://convoy.test',
      publicOrigin: 'https://convoy.test',
      capabilities: ['organizations', 'provider-connections'],
      authenticationMethods: ['local-bootstrap'],
    },
  });
  t.after(() => runtime.close());
  const client = 'tenant-client';
  const command = (action, input = {}) => runtime.command({ action, client, ...input });

  const organization = await command('createOrganization', {
    slug: 'acme',
    displayName: 'Acme',
    kind: 'enterprise',
  });
  const project = await command('saveProject', {
    organizationId: organization.id,
    name: 'Payments',
  });
  const context = await command('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  assert.equal(context.organizationId, organization.id);

  const connection = await command('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'openai-compatible',
    displayName: 'Private gateway',
    owner: { kind: 'organization', organizationId: organization.id },
    endpoint: { origin: 'https://models.acme.test/v1', region: 'eu' },
    credentialRef: { kind: 'external', reference: 'vault://secret/models' },
  });
  const probe = await command('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  await command('createModelRoute', {
    organizationId: organization.id,
    name: 'private-eu',
    purposes: ['coding'],
    candidates: [
      {
        connectionId: connection.id,
        offeringId: probe.offerings[0].id,
        allowedResidencies: ['eu'],
      },
    ],
    policy: { fallback: 'never', allowedResidencies: ['eu'] },
  });

  const snapshot = await runtime.snapshot(undefined, client);
  assert.equal(snapshot.activeContext.organizationId, organization.id);
  assert.equal(
    snapshot.availableContexts.some((value) => value.projectId === project.id),
    true,
  );
  assert.deepEqual(
    snapshot.projects.map((value) => value.id),
    [project.id],
  );
  assert.equal(
    snapshot.environments.every((value) => value.organizationId === organization.id),
    true,
  );
  assert.equal(
    snapshot.runners.every((value) => value.organizationId === organization.id),
    true,
  );
  assert.equal(snapshot.providerConnections.length, 1);
  assert.deepEqual(snapshot.providerConnections[0].credentialRef, { kind: 'external' });
  assert.equal(JSON.stringify(snapshot).includes('vault://secret/models'), false);
  assert.equal(snapshot.modelRoutes[0].name, 'private-eu');

  await assert.rejects(
    runtime.command({
      action: 'createProviderConnection',
      client: 'different-client',
      organizationId: organization.id,
      providerId: 'openai-compatible',
      displayName: 'Wrong context',
      owner: { kind: 'organization', organizationId: organization.id },
      credentialRef: { kind: 'none' },
    }),
    /Not authorized/,
  );
});

test('an authorized team member can work until inherited organization policy denies the action', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-tenant-policy-'));
  let providerInvocations = 0;
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    generate: async function* () {},
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth,
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': () => ({
        protocol: 'openai-compatible',
        capabilities: ['streaming'],
        inspectConnection: async () => ({ available: true }),
        discoverModels: async () => [{ id: 'personal-model', name: 'Personal model' }],
        async *generate() {
          providerInvocations++;
          yield {
            type: 'result',
            message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() },
          };
        },
      }),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
  };
  let runtime = await createRuntime(options);
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.identity.users.push({
    id: 'team-user',
    displayName: 'Team user',
    state: 'active',
    revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  });
  await writeFile(statePath, JSON.stringify(state));
  runtime = await createRuntime(options);
  t.after(() => runtime.close());
  const owner = { kind: 'user', userId: 'local' };
  const member = { kind: 'user', userId: 'team-user' };
  const ownerCommand = (action, input = {}) =>
    runtime.command({ action, client: 'policy-owner', ...input }, owner);
  const organization = await ownerCommand('createOrganization', {
    slug: 'policy-org',
    displayName: 'Policy Org',
    kind: 'team',
  });
  const team = await ownerCommand('createTeam', {
    organizationId: organization.id,
    slug: 'engineering',
    displayName: 'Engineering',
  });
  const project = await ownerCommand('saveProject', {
    organizationId: organization.id,
    teamId: team.id,
    name: 'Governed project',
  });
  await ownerCommand('selectActiveContext', {
    context: { organizationId: organization.id, teamId: team.id, projectId: project.id },
  });
  await ownerCommand('createMembership', {
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await ownerCommand('createMembership', {
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'project', projectId: project.id },
    roles: ['maintainer'],
  });
  const memberCommand = (action, input = {}) =>
    runtime.command({ action, client: 'policy-member', ...input }, member);
  await memberCommand('selectActiveContext', {
    context: { organizationId: organization.id, teamId: team.id, projectId: project.id },
  });
  const allowed = await memberCommand('createConversation', {
    requestId: 'before-policy',
    projectId: project.id,
  });
  assert.ok(allowed.sessionId ?? allowed.id);
  const connection = await ownerCommand('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'openai-compatible',
    displayName: 'Member API account',
    owner: { kind: 'user', userId: member.userId },
    endpoint: { origin: 'https://models.example/v1' },
    credentialRef: { kind: 'none' },
  });
  const probe = await ownerCommand('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await ownerCommand('createModelRoute', {
    organizationId: organization.id,
    name: 'member-personal-route',
    purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
  });
  const workflow = await memberCommand('saveWorkflow', {
    workflow: {
      id: 'team-review',
      name: 'Team review',
      nodes: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Review the result' }],
      edges: [],
    },
    baseVersion: 0,
    makeDefault: true,
  });
  assert.equal(workflow.organizationId, organization.id);
  assert.equal(workflow.projectId, project.id);

  await ownerCommand('saveOrganizationPolicy', {
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    rules: {
      personalProviders: 'deny',
    },
    baseRevision: 0,
  });
  await memberCommand('selectActiveContext', {
    context: { organizationId: organization.id, teamId: team.id, projectId: project.id },
  });
  await memberCommand('claim', { sessionId: allowed.sessionId ?? allowed.id, label: 'Member' });
  await memberCommand('start', {
    sessionId: allowed.sessionId ?? allowed.id,
    model: route.id,
    text: 'This personal provider must not run.',
    requestId: 'personal-provider-denied',
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = (
      await runtime.snapshot(allowed.sessionId ?? allowed.id, 'policy-member', member)
    ).sessions[0];
    if (!current.control.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(providerInvocations, 0);
  await ownerCommand('saveOrganizationPolicy', {
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    rules: {
      permissions: { 'project.write': 'deny' },
      personalProviders: 'deny',
    },
    baseRevision: 1,
  });
  await memberCommand('selectActiveContext', {
    context: { organizationId: organization.id, teamId: team.id, projectId: project.id },
  });
  await assert.rejects(
    memberCommand('createConversation', {
      requestId: 'after-policy',
      projectId: project.id,
    }),
    /Not authorized/,
  );
  const snapshot = await runtime.snapshot(undefined, 'policy-member', member);
  assert.equal(snapshot.policies.length, 1);
  assert.equal(
    snapshot.projects.every((candidate) => candidate.organizationId === organization.id),
    true,
  );
});

test('a conversation selects a logical route and dispatches through its connection adapter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-routed-turn-'));
  let legacyTokenCalls = 0;
  const generated = [];
  const credentials = [];
  const storedCredentials = [];
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'legacy' }],
    generate: async function* () {
      assert.fail('legacy generator was called');
    },
    provider: { id: 'legacy', name: 'Legacy', capabilities: [] },
    auth: {
      token: async () => {
        legacyTokenCalls++;
        return 'legacy-token';
      },
      status: async () => ({ source: 'test', connected: false, device: { state: 'idle' } }),
    },
    credentialBroker: {
      async store(request) {
        storedCredentials.push(structuredClone(request));
        return { kind: 'external', reference: 'broker://stored/connection-secret' };
      },
      async resolve(request) {
        credentials.push(structuredClone(request));
        return { value: 'routed-secret' };
      },
    },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': ({ connection }) => ({
        protocol: 'openai-compatible',
        capabilities: ['streaming', 'tool-calls'],
        inspectConnection: async () => ({ available: true }),
        discoverModels: async () => [
          { id: 'private-coder-v3', name: 'Private Coder', input: ['text'] },
        ],
        async *generate(input) {
          generated.push({
            connectionId: connection.id,
            model: input.model,
            token: input.token,
            grant: input.providerGrant,
          });
          yield {
            type: 'result',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Routed response' }],
              stopReason: 'stop',
              timestamp: Date.now(),
            },
            usage: { inputTokens: 12, outputTokens: 2, costUsd: 0.02 },
            providerRequestId: 'upstream_1',
          };
        },
      }),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
  });
  t.after(() => runtime.close());
  const client = 'routed-client';
  const command = (action, input = {}) => runtime.command({ action, client, ...input });
  const organization = await command('createOrganization', {
    slug: 'routed',
    displayName: 'Routed Org',
    kind: 'team',
  });
  const project = await command('saveProject', {
    organizationId: organization.id,
    name: 'Routed Project',
  });
  await command('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const connection = await command('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'openai-compatible',
    displayName: 'Private gateway',
    owner: { kind: 'organization', organizationId: organization.id },
    endpoint: { origin: 'https://models.example/v1' },
    credentialValue: 'one-time-routed-secret',
  });
  const probe = await command('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await command('createModelRoute', {
    organizationId: organization.id,
    name: 'coding-default',
    purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
    policy: { fallback: 'never' },
  });
  const conversation = await command('createConversation', {
    requestId: 'routed-chat',
    projectId: project.id,
  });
  await command('claim', { sessionId: conversation.sessionId, label: 'Acceptance' });
  await command('start', {
    sessionId: conversation.sessionId,
    model: route.id,
    text: 'Use the governed route.',
    requestId: 'routed-turn',
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = (await runtime.snapshot(conversation.sessionId, client)).sessions[0];
    if (!session.control.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const snapshot = await runtime.snapshot(conversation.sessionId, client);
  const session = snapshot.sessions[0];
  assert.equal(session.status, 'awaiting_review');
  assert.equal(
    session.events.findLast((event) => event.type === 'assistant').text,
    'Routed response',
  );
  assert.equal(legacyTokenCalls, 0);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].model, 'private-coder-v3');
  assert.equal(generated[0].token, 'routed-secret');
  assert.match(generated[0].grant.digest, /^sha256:/);
  assert.equal(
    credentials.find((value) => value.purpose === 'generate').providerConnectionId,
    connection.id,
  );
  assert.equal(storedCredentials[0].providerConnectionId, connection.id);
  assert.equal(storedCredentials[0].value, 'one-time-routed-secret');
  assert.equal(snapshot.providerOutcomes[0].classification, 'completed');
  assert.equal(JSON.stringify(snapshot).includes('routed-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('one-time-routed-secret'), false);
  assert.equal(
    (await readFile(join(directory, 'state.json'), 'utf8')).includes('one-time-routed-secret'),
    false,
  );
});

test('routed grants use the authenticated initiating principal instead of the local bootstrap user', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-routed-principal-'));
  const generated = [];
  const options = {
    directory,
    models: [{ id: 'legacy' }],
    generate: async function* () {
      assert.fail('legacy generator was called');
    },
    provider: { id: 'legacy', name: 'Legacy', capabilities: [] },
    auth: {
      token: async () => assert.fail('legacy auth was called'),
      status: async () => ({ source: 'test', connected: false }),
    },
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': () => ({
        protocol: 'openai-compatible',
        capabilities: ['streaming'],
        inspectConnection: async () => ({ available: true }),
        discoverModels: async () => [{ id: 'alice-model', name: 'Alice Model', input: ['text'] }],
        async *generate(input) {
          generated.push(input.providerGrant);
          yield {
            type: 'result',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Alice response' }],
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          };
        },
      }),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
  };
  let runtime = await createRuntime(options);
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.identity.users.push({
    id: 'alice',
    displayName: 'Alice',
    state: 'active',
    revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  });
  await writeFile(statePath, JSON.stringify(state));
  runtime = await createRuntime(options);
  t.after(() => runtime.close());
  const local = { kind: 'user', userId: 'local' };
  const alice = { kind: 'user', userId: 'alice' };
  const localCommand = (action, input = {}) =>
    runtime.command({ action, client: 'local-admin', ...input }, local);
  const organization = await localCommand('createOrganization', {
    slug: 'alice-org',
    displayName: 'Alice Org',
    kind: 'team',
  });
  const project = await localCommand('saveProject', {
    organizationId: organization.id,
    name: 'Alice Project',
  });
  await localCommand('createMembership', {
    organizationId: organization.id,
    principal: alice,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await localCommand('createMembership', {
    organizationId: organization.id,
    principal: alice,
    scope: { kind: 'project', projectId: project.id },
    roles: ['contributor'],
  });
  await localCommand('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const connection = await localCommand('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'openai-compatible',
    displayName: 'Alice local model',
    owner: { kind: 'user', userId: 'alice' },
    endpoint: { origin: 'http://models.internal/v1' },
    credentialRef: { kind: 'none' },
  });
  const probe = await localCommand('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await localCommand('createModelRoute', {
    organizationId: organization.id,
    name: 'alice-route',
    purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
  });

  const command = (action, input = {}) =>
    runtime.command({ action, client: 'alice-client', ...input }, alice);
  await command('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const conversation = await command('createConversation', {
    requestId: 'alice-chat',
    projectId: project.id,
  });
  await command('claim', { sessionId: conversation.id });
  await command('start', {
    sessionId: conversation.id,
    model: route.id,
    text: 'Run as Alice.',
    requestId: 'alice-turn',
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    if (persisted.providerOutcomes?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(generated.length, 1);
  assert.equal(persisted.providerGrants[0].userId, 'alice');
  assert.notEqual(persisted.providerGrants[0].userId, 'local');
});

test('provider credential rotation and revocation invalidate each prior broker reference', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-provider-rotation-'));
  let stored = 0;
  const deleted = [];
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'legacy' }],
    generate: async function* () {},
    provider: { id: 'legacy', name: 'Legacy', capabilities: [] },
    auth,
    credentialBroker: {
      store: async () => ({ kind: 'encrypted', reference: `secret_${++stored}`, version: '1' }),
      delete: async (input) => deleted.push(input.credentialRef.reference),
      resolve: async () => ({ value: 'secret' }),
    },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': () => probeAdapter('model'),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
  });
  t.after(() => runtime.close());
  const command = (action, input = {}) =>
    runtime.command({ action, client: 'credential-admin', ...input });
  const connection = await command('createProviderConnection', {
    organizationId: 'personal',
    providerId: 'openai-compatible',
    displayName: 'Rotated',
    owner: { kind: 'user', userId: 'local' },
    credentialValue: 'first',
  });
  const rotated = await command('rotateProviderCredential', {
    organizationId: 'personal',
    connectionId: connection.id,
    expectedRevision: connection.revision,
    credentialValue: 'second',
  });
  assert.deepEqual(deleted, ['secret_1']);
  await command('revokeProviderCredential', {
    organizationId: 'personal',
    connectionId: connection.id,
    expectedRevision: rotated.revision,
  });
  assert.deepEqual(deleted, ['secret_1', 'secret_2']);
});
