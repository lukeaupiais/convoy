import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderGateway } from '../../apps/daemon/src/control-plane/provider-gateway.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

test('gateway falls through only after a safe terminal outcome and audits separate grants', async () => {
  const outcomes = [];
  const audits = [];
  const grants = [
    {
      id: 'grant_1',
      digest: 'sha256:first',
      organizationId: 'org_1',
      routeRevision: 'route_1',
      connectionRevision: 'connection_1',
      policyRevision: 'policy_1',
      providerConnectionId: 'connection_1',
      modelOfferingId: 'offering_1',
      routeId: 'route_1',
    },
    {
      id: 'grant_2',
      digest: 'sha256:second',
      organizationId: 'org_1',
      routeRevision: 'route_1',
      connectionRevision: 'connection_2',
      policyRevision: 'policy_1',
      providerConnectionId: 'connection_2',
      modelOfferingId: 'offering_2',
      routeId: 'route_1',
      previousGrantId: 'grant_1',
    },
  ];
  const routing = {
    describeRoute: async () => ({ id: 'route_1', name: 'Route', input: ['text'] }),
    resolveGrant: async () => grants[0],
    resolveFallbackGrant: async (id) => {
      assert.equal(id, 'grant_1');
      return grants[1];
    },
    prepareDispatch: async (id) => ({
      grant: grants[id === 'grant_1' ? 0 : 1],
      connection: {
        id: id === 'grant_1' ? 'connection_1' : 'connection_2',
        providerId: id === 'grant_1' ? 'direct' : 'gateway',
        credentialRef: { kind: 'none' },
      },
      offering: {
        id: id === 'grant_1' ? 'offering_1' : 'offering_2',
        upstreamModelId: id === 'grant_1' ? 'model_1' : 'model_2',
      },
    }),
    recordOutcome: async (id, input) => {
      outcomes.push({ id, ...input });
      return {
        ...input,
        fallbackAllowed: input.classification === 'rejected',
        reconciliationRequired: input.classification === 'uncertain',
      };
    },
  };
  const adapters = createProviderAdapterRegistry({
    direct: () => ({
      async *generate() {
        const error = new Error('rejected');
        error.providerOutcome = 'rejected';
        throw error;
      },
    }),
    gateway: () => ({
      async *generate(input) {
        assert.equal(input.model, 'model_2');
        assert.equal(input.providerGrant.id, 'grant_2');
        yield {
          type: 'result',
          message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: 1 },
        };
      },
    }),
  });
  const gateway = createProviderGateway({
    routing,
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    adapters,
    audit: async (entry) => audits.push(entry),
    legacyGenerate: async function* () {},
  });

  const result = [];
  for await (const item of gateway.generate({
    model: 'route_1',
    purpose: 'coding',
    sessionId: 'session_1',
    turnId: 'turn_1',
    context: {
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: 'project_1',
      policyRevision: 'policy_1',
    },
  }))
    result.push(item);

  assert.equal(result.at(-1).type, 'result');
  assert.deepEqual(
    outcomes.map(({ id, classification }) => ({ id, classification })),
    [
      { id: 'grant_1', classification: 'rejected' },
      { id: 'grant_2', classification: 'completed' },
    ],
  );
  assert.equal(
    audits.some((entry) => entry.provider?.grantId === 'grant_1' && entry.outcome === 'failed'),
    true,
  );
  assert.equal(
    audits.some((entry) => entry.provider?.grantId === 'grant_2' && entry.outcome === 'completed'),
    true,
  );
  assert.equal(JSON.stringify(audits).includes('credentialRef'), false);
});

test('gateway reauthorizes the selected connection before resolving its credential', async () => {
  let credentialCalls = 0;
  const grant = {
    id: 'grant_personal',
    digest: 'sha256:personal',
    organizationId: 'org_1',
    routeRevision: 'route_1',
    connectionRevision: 'connection_1',
    policyRevision: 'policy_1',
    providerConnectionId: 'connection_1',
    modelOfferingId: 'offering_1',
    routeId: 'route_1',
  };
  const gateway = createProviderGateway({
    routing: {
      describeRoute: async () => ({ id: 'route_1' }),
      resolveGrant: async () => grant,
      prepareDispatch: async () => ({
        grant,
        connection: {
          id: 'connection_1',
          providerId: 'direct',
          credentialRef: { kind: 'none' },
          owner: { kind: 'user', userId: 'user_1' },
        },
        offering: { id: 'offering_1', upstreamModelId: 'model_1' },
      }),
      recordOutcome: async () => ({ fallbackAllowed: false }),
    },
    credentialBroker: {
      resolve: async () => {
        credentialCalls++;
        return { value: undefined };
      },
    },
    adapters: createProviderAdapterRegistry({ direct: () => ({ async *generate() {} }) }),
    authorizeContext: async (_context, _purpose, plan) => !plan?.connection?.owner,
    legacyGenerate: async function* () {},
  });
  await assert.rejects(async () => {
    for await (const _ of gateway.generate({
      model: 'route_1',
      purpose: 'coding',
      sessionId: 'session_1',
      turnId: 'turn_1',
      context: {
        organizationId: 'org_1',
        userId: 'user_1',
        projectId: 'project_1',
        policyRevision: 'policy_1',
      },
    })) {
    }
  }, /no longer authorized/);
  assert.equal(credentialCalls, 0);
});

test('gateway never falls back after uncertain dispatch', async () => {
  let fallbackCalls = 0;
  const error = new Error('connection ended');
  error.providerOutcome = 'uncertain';
  const gateway = createProviderGateway({
    routing: {
      describeRoute: async () => ({ id: 'route_1' }),
      resolveGrant: async () => ({ id: 'grant_1', digest: 'sha256:one', organizationId: 'org_1' }),
      resolveFallbackGrant: async () => {
        fallbackCalls++;
      },
      prepareDispatch: async () => ({
        grant: { id: 'grant_1', digest: 'sha256:one', organizationId: 'org_1' },
        connection: { id: 'connection_1', providerId: 'direct', credentialRef: { kind: 'none' } },
        offering: { id: 'offering_1', upstreamModelId: 'model_1' },
      }),
      recordOutcome: async (_id, input) => ({
        ...input,
        fallbackAllowed: false,
        reconciliationRequired: true,
      }),
    },
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    adapters: createProviderAdapterRegistry({
      direct: () => ({
        async *generate() {
          throw error;
        },
      }),
    }),
    legacyGenerate: async function* () {},
  });
  await assert.rejects(async () => {
    for await (const _ of gateway.generate({
      model: 'route_1',
      purpose: 'coding',
      sessionId: 'session_1',
      turnId: 'turn_1',
      context: { organizationId: 'org_1', userId: 'user_1' },
    })) {
    }
  }, /connection ended/);
  assert.equal(fallbackCalls, 0);
});
