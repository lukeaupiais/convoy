import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

async function until(read) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for audited execution.');
}

test('audit export reconstructs one governed provider and runner dispatch without secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-security-audit-'));
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'legacy' }],
    generate: async function* () {
      assert.fail('Legacy provider must not be selected.');
    },
    provider: { id: 'legacy', name: 'Legacy', capabilities: [] },
    auth: {
      token: async () => 'legacy-secret',
      status: async () => ({ connected: false }),
    },
    credentialBroker: { resolve: async () => ({ value: 'provider-secret-never-audited' }) },
    providerAdapters: createProviderAdapterRegistry({
      'openai-compatible': () => ({
        protocol: 'openai-compatible',
        capabilities: ['streaming'],
        async inspectConnection() {
          return { available: true };
        },
        async discoverModels() {
          return [
            {
              id: 'audited-model',
              name: 'Audited model',
              verifiedCapabilities: { inputModalities: ['text'], streaming: true },
            },
          ];
        },
        async *generate() {
          yield {
            type: 'result',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Audited response' }],
              stopReason: 'stop',
              timestamp: Date.now(),
            },
            usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.01 },
            providerRequestId: 'provider_request_1',
          };
        },
      }),
    }),
    runners: {
      async execute(_runner, input) {
        if (input.action === 'probe')
          return { repository: '/fixture', tools: ['read_file'], shell: true };
        if (input.action === 'provision')
          return { path: `/fixture/${input.workspaceId}`, branch: input.workspaceId };
        if (input.action === 'diff') return { digest: 'clean' };
        return {};
      },
      close: async () => {},
    },
  });
  t.after(() => runtime.close());
  const client = 'security-audit-client';
  const command = (action, input = {}) => runtime.command({ action, client, ...input });

  const connection = await command('createProviderConnection', {
    organizationId: 'personal',
    providerId: 'openai-compatible',
    displayName: 'Audited provider',
    owner: { kind: 'organization', organizationId: 'personal' },
    endpoint: { origin: 'https://provider.invalid/v1' },
    credentialRef: { kind: 'none' },
  });
  const probe = await command('probeProviderConnection', {
    organizationId: 'personal',
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await command('createModelRoute', {
    organizationId: 'personal',
    name: 'audited-route',
    purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
    policy: { fallback: 'never' },
  });
  const runner = await command('registerRunner', {
    name: 'Audited runner',
    kind: 'local',
    repository: '/fixture',
    projectIds: ['agent-platform'],
  });
  const conversation = await command('createConversation', {
    requestId: 'audited-chat',
    projectId: 'agent-platform',
    placement: { mode: 'pinned', runnerId: runner.id },
  });
  await command('claim', { sessionId: conversation.sessionId });
  await command('start', {
    sessionId: conversation.sessionId,
    requestId: 'audited-turn',
    text: 'Run through governed provider and execution.',
    model: route.id,
  });
  await until(async () => {
    const session = (await runtime.snapshot(conversation.sessionId, client)).sessions[0];
    return !session.control.busy;
  });

  const page = await command('querySecurityAudit', {
    organizationId: 'personal',
    limit: 500,
  });
  const provider = page.records.find(
    (record) => record.action === 'provider.dispatch' && record.outcome === 'completed',
  );
  const execution = page.records.find(
    (record) => record.action === 'runner.dispatch' && record.outcome === 'started',
  );
  assert.equal(provider.provider.connectionId, connection.id);
  assert.equal(provider.provider.modelOfferingId, probe.offerings[0].id);
  assert.match(provider.revisions.providerGrantDigest, /^sha256:/);
  assert.equal(execution.execution.runnerId, runner.id);
  assert.equal(execution.execution.environmentId, runner.environmentId);
  assert.equal(execution.context.projectId, 'agent-platform');
  assert.match(execution.revisions.executionGrantDigest, /^[a-f0-9]{64}$/);

  const exported = await command('exportSecurityAudit', {
    organizationId: 'personal',
    limit: 500,
  });
  const serializedState = await readFile(join(directory, 'state.json'), 'utf8');
  for (const value of [exported.content, serializedState]) {
    assert.equal(value.includes('provider-secret-never-audited'), false);
    assert.equal(value.includes('legacy-secret'), false);
  }
});

test('audit query authorization never exposes another organization history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-audit-tenants-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    generate: async function* () {},
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth: { token: async () => 'unused', status: async () => ({ connected: true }) },
    runners: { execute: async () => ({}), close: async () => {} },
  };
  let runtime = await createRuntime(options);
  const localCommand = (action, input = {}) =>
    runtime.command({ action, client: 'audit-local-admin', ...input });
  const allowed = await localCommand('createOrganization', {
    slug: 'allowed-audit',
    displayName: 'Allowed Audit',
    kind: 'enterprise',
  });
  const forbidden = await localCommand('createOrganization', {
    slug: 'forbidden-audit',
    displayName: 'Forbidden Audit',
    kind: 'enterprise',
  });
  await runtime.close();

  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.identity.users.push({
    id: 'security-reader',
    displayName: 'Security Reader',
    state: 'active',
    revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  });
  state.organizations.memberships.push({
    id: 'membership-security-reader',
    organizationId: allowed.id,
    principal: { kind: 'user', userId: 'security-reader' },
    scope: { kind: 'organization', organizationId: allowed.id },
    roles: ['security-admin'],
    state: 'active',
    revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  });
  await writeFile(statePath, JSON.stringify(state));

  runtime = await createRuntime(options);
  t.after(() => runtime.close());
  const principal = { kind: 'user', userId: 'security-reader' };
  const query = (organizationId) =>
    runtime.command(
      {
        action: 'querySecurityAudit',
        client: 'audit-security-reader',
        organizationId,
      },
      principal,
    );
  assert.equal(
    (await query(allowed.id)).records.every((record) => record.organizationId === allowed.id),
    true,
  );
  await assert.rejects(query(forbidden.id), /Not authorized/);
});
