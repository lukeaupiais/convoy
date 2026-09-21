import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderProbe } from '../../apps/daemon/src/control-plane/provider-probe.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';
import { createProviders } from '../../apps/daemon/src/modules/providers/index.mjs';

test('provider probe obtains credentials server-side and publishes adapter-observed evidence', async () => {
  const recorded = [];
  const resolved = [];
  const probe = createProviderProbe({
    administration: {
      prepareProbe: async () => ({
        id: 'connection_1',
        organizationId: 'org_1',
        providerId: 'openai-compatible',
        endpoint: { origin: 'https://api.example.test/v1' },
        credentialRef: { kind: 'external', reference: 'vault://provider' },
        revision: 'revision_1',
      }),
      recordProbe: async (input) => {
        recorded.push(input);
        return input;
      },
    },
    credentialBroker: {
      resolve: async (input) => {
        resolved.push(input);
        return { value: 'secret' };
      },
    },
    adapters: createProviderAdapterRegistry({
      'openai-compatible': () => ({
        inspectConnection: async ({ token }) => ({
          available: token === 'secret',
          protocol: 'openai-compatible',
        }),
        discoverModels: async () => [{ id: 'coder', name: 'Coder', input: ['text'] }],
        async *generate() {},
      }),
    }),
  });

  const result = await probe.run({
    organizationId: 'org_1',
    connectionId: 'connection_1',
    expectedRevision: 'revision_1',
    actor: { kind: 'user', userId: 'user_1' },
  });
  assert.equal(resolved[0].purpose, 'discover-models');
  assert.equal(recorded[0].evidence.source, 'server-active-probe');
  assert.equal(recorded[0].offerings[0].upstreamModelId, 'coder');
  assert.equal(result.offerings[0].displayName, 'Coder');
  assert.equal(JSON.stringify(recorded).includes('secret'), false);
});

test('direct API, intermediate gateway, and credential-free local models share one route and grant contract', async () => {
  let sequence = 0;
  const state = {};
  const providers = createProviders({
    state,
    now: () => '2026-09-20T12:00:00.000Z',
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  const observedCredentialKinds = [];
  const adapter = (connection) => ({
    protocol: 'openai-compatible',
    capabilities: ['streaming'],
    inspectConnection: async () => ({ available: true }),
    discoverModels: async () => [
      { id: `${connection.providerId}-coder`, name: 'Coder', input: ['text'] },
    ],
    async *generate() {},
  });
  const probe = createProviderProbe({
    administration: providers.administration,
    credentialBroker: {
      resolve: async (request) => {
        observedCredentialKinds.push(request.credentialRef.kind);
        return { value: request.credentialRef.kind === 'none' ? undefined : 'secret' };
      },
    },
    adapters: createProviderAdapterRegistry({
      'direct-api': ({ connection }) => adapter(connection),
      openrouter: ({ connection }) => adapter(connection),
      local: ({ connection }) => adapter(connection),
    }),
  });
  const configurations = [
    ['direct-api', { kind: 'encrypted', reference: 'direct-secret', version: '1' }],
    ['openrouter', { kind: 'external', reference: 'vault://openrouter', version: '3' }],
    ['local', { kind: 'none' }],
  ];
  const grantProviderIds = [];
  for (const [providerId, credentialRef] of configurations) {
    const connection = await providers.administration.createConnection({
      organizationId: 'org_1',
      providerId,
      displayName: providerId,
      owner: { kind: 'user', userId: 'user_1' },
      credentialRef,
    });
    const observed = await probe.run({
      organizationId: 'org_1',
      connectionId: connection.id,
      expectedRevision: connection.revision,
      actor: { kind: 'user', userId: 'user_1' },
    });
    const route = await providers.administration.createRoute({
      organizationId: 'org_1',
      name: providerId,
      purposes: ['coding'],
      candidates: [{ connectionId: connection.id, offeringId: observed.offerings[0].id }],
    });
    const grant = await providers.routing.resolveGrant({
      context: {
        organizationId: 'org_1',
        userId: 'user_1',
        projectId: 'project_1',
        policyRevision: 'policy_1',
      },
      routeId: route.id,
      purpose: 'coding',
      sessionId: `session_${providerId}`,
      turnId: 'turn_1',
    });
    grantProviderIds.push(
      (await providers.routing.prepareDispatch(grant.id)).connection.providerId,
    );
  }
  assert.deepEqual(observedCredentialKinds, ['encrypted', 'external', 'none']);
  assert.deepEqual(grantProviderIds, ['direct-api', 'openrouter', 'local']);
});
