import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderGateway } from '../../apps/daemon/src/control-plane/provider-gateway.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

test('a logical model route dispatches its pinned offering through a purpose-bound credential', async () => {
  const calls = [];
  const routing = {
    async describeRoute(context, routeId) {
      calls.push(['describe', context.organizationId, routeId]);
      return { id: routeId, name: 'Private EU', input: ['text'] };
    },
    async resolveGrant(request) {
      calls.push(['resolve', request.routeId, request.turnId]);
      return { id: 'grant_1', digest: 'sha256:grant', ...request };
    },
    async prepareDispatch(grantId, current) {
      calls.push(['prepare', grantId, current.policyRevision]);
      return {
        grant: {
          id: grantId,
          organizationId: 'org_1',
          providerConnectionId: 'connection_1',
          purpose: 'coding',
        },
        connection: {
          id: 'connection_1',
          providerId: 'openai-compatible',
          endpoint: { origin: 'https://models.example/v1' },
          credentialRef: { kind: 'external', reference: 'vault://models/key' },
        },
        offering: { id: 'offering_1', upstreamModelId: 'private-coder-v3' },
      };
    },
    async recordOutcome(grantId, outcome) {
      calls.push(['outcome', grantId, outcome.classification]);
    },
  };
  const credentialBroker = {
    async resolve(request) {
      calls.push(['credential', request.purpose, request.providerConnectionId, request.turnId]);
      return { value: 'secret-token', expiresAt: '2026-09-20T12:01:00.000Z' };
    },
  };
  const adapters = createProviderAdapterRegistry({
    'openai-compatible': ({ connection }) => ({
      async *generate(input) {
        calls.push(['generate', connection.id, input.model, input.token, input.providerGrant.id]);
        yield { type: 'delta', text: 'hello' };
        yield {
          type: 'result',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            stopReason: 'stop',
          },
          usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
          providerRequestId: 'request_1',
        };
      },
    }),
  });
  const gateway = createProviderGateway({
    routing,
    credentialBroker,
    adapters,
    legacyModels: [{ id: 'legacy-model', input: ['text'] }],
    legacyGenerate: async function* () {},
  });

  const selection = await gateway.describeModel('route_private', { organizationId: 'org_1' });
  assert.deepEqual(selection, { id: 'route_private', name: 'Private EU', input: ['text'] });

  const output = [];
  for await (const item of gateway.generate({
    model: 'route_private',
    messages: [{ role: 'user', content: 'hello' }],
    context: {
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: 'project_1',
      policyRevision: 'policy_7',
    },
    purpose: 'coding',
    sessionId: 'session_1',
    turnId: 'turn_1',
  }))
    output.push(item);

  assert.equal(output.at(-1).message.content[0].text, 'hello');
  assert.equal(JSON.stringify(output).includes('secret-token'), false);
  assert.deepEqual(calls, [
    ['describe', 'org_1', 'route_private'],
    ['resolve', 'route_private', 'turn_1'],
    ['prepare', 'grant_1', 'policy_7'],
    ['credential', 'generate', 'connection_1', 'turn_1'],
    ['generate', 'connection_1', 'private-coder-v3', 'secret-token', 'grant_1'],
    ['outcome', 'grant_1', 'completed'],
  ]);
});

test('a routed disconnect after dispatch records uncertainty and does not replay', async () => {
  const outcomes = [];
  const routing = {
    async describeRoute() {
      return { id: 'route_1', input: ['text'] };
    },
    async resolveGrant(request) {
      return { id: 'grant_1', ...request };
    },
    async prepareDispatch() {
      return {
        grant: {
          id: 'grant_1',
          organizationId: 'org_1',
          providerConnectionId: 'connection_1',
        },
        connection: {
          id: 'connection_1',
          providerId: 'custom',
          credentialRef: { kind: 'none' },
        },
        offering: { id: 'offering_1', upstreamModelId: 'model_1' },
      };
    },
    async recordOutcome(_grantId, outcome) {
      outcomes.push(outcome);
    },
  };
  const gateway = createProviderGateway({
    routing,
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    adapters: createProviderAdapterRegistry({
      custom: () => ({
        async *generate() {
          throw new Error('socket closed');
        },
      }),
    }),
    legacyModels: [],
    legacyGenerate: async function* () {},
  });

  await assert.rejects(async () => {
    for await (const _item of gateway.generate({
      model: 'route_1',
      context: { organizationId: 'org_1', policyRevision: 'policy_1' },
      purpose: 'coding',
      sessionId: 'session_1',
      turnId: 'turn_1',
    })) {
      // consume the dispatch
    }
  }, /socket closed/);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].classification, 'uncertain');
});

test('a stale organization context is denied before provider grant or dispatch', async () => {
  let resolved = false;
  const gateway = createProviderGateway({
    routing: {
      async resolveGrant() {
        resolved = true;
      },
    },
    credentialBroker: { resolve: async () => assert.fail('credential broker was called') },
    adapters: createProviderAdapterRegistry({}),
    authorizeContext: async () => false,
    legacyModels: [],
    legacyGenerate: async function* () {},
  });
  await assert.rejects(
    async () => {
      for await (const _ of gateway.generate({
        model: 'route_1',
        context: { organizationId: 'org_1', policyRevision: 'stale' },
        purpose: 'coding',
        sessionId: 'session_1',
        turnId: 'turn_1',
      }))
        void _;
    },
    /no longer authorized/,
  );
  assert.equal(resolved, false);
});

test('a raw legacy model bypasses routing and preserves the existing generator contract', async () => {
  let routed = false;
  let received;
  const gateway = createProviderGateway({
    routing: {
      async describeRoute() {
        routed = true;
      },
      async resolveGrant() {
        routed = true;
      },
    },
    credentialBroker: { resolve: async () => assert.fail('credential broker was called') },
    adapters: createProviderAdapterRegistry({}),
    legacyModels: [{ id: 'legacy-model', name: 'Legacy', input: ['text', 'image'] }],
    legacyGenerate: async function* (input) {
      received = input;
      yield { type: 'result', message: { role: 'assistant', content: [], stopReason: 'stop' } };
    },
  });

  assert.deepEqual(await gateway.describeModel('legacy-model'), {
    id: 'legacy-model',
    name: 'Legacy',
    input: ['text', 'image'],
  });
  for await (const _item of gateway.generate({
    model: 'legacy-model',
    token: 'legacy-token',
    messages: [],
  })) {
    // consume legacy output
  }
  assert.equal(received.token, 'legacy-token');
  assert.equal(routed, false);
});

test('subscription, direct, gateway, and local providers traverse the same grant contract', async () => {
  for (const providerId of [
    'openai-codex-subscription',
    'openai-direct',
    'openrouter-gateway',
    'local-openai-compatible',
  ]) {
    const calls = [];
    const gateway = createProviderGateway({
      routing: {
        async resolveGrant(request) {
          calls.push('grant');
          return { id: `grant:${providerId}`, digest: 'digest', ...request };
        },
        async prepareDispatch() {
          calls.push('prepare');
          return {
            grant: {
              id: `grant:${providerId}`,
              organizationId: 'personal',
              providerConnectionId: `connection:${providerId}`,
            },
            connection: {
              id: `connection:${providerId}`,
              providerId,
              credentialRef:
                providerId === 'local-openai-compatible'
                  ? { kind: 'none' }
                  : providerId === 'openai-codex-subscription'
                    ? { kind: 'subscription', reference: 'chatgpt-oauth', version: '1' }
                    : { kind: 'external', reference: `vault://${providerId}` },
            },
            offering: { id: `offering:${providerId}`, upstreamModelId: 'upstream-model' },
          };
        },
        async recordOutcome(_grantId, outcome) {
          calls.push(`outcome:${outcome.classification}`);
        },
      },
      credentialBroker: {
        async resolve(request) {
          calls.push(`credential:${request.credentialRef.kind}`);
          return {
            value: request.credentialRef.kind === 'none' ? undefined : 'ephemeral-secret',
          };
        },
      },
      adapters: createProviderAdapterRegistry({
        [providerId]: () => ({
          async *generate(input) {
            calls.push(`adapter:${input.model}:${input.sessionId}:${input.turnId}`);
            yield {
              type: 'result',
              message: { role: 'assistant', content: [], stopReason: 'stop' },
            };
          },
        }),
      }),
      legacyModels: [],
      legacyGenerate: async function* () {},
    });
    for await (const _ of gateway.generate({
      model: `route:${providerId}`,
      context: {
        organizationId: 'personal',
        userId: 'local',
        projectId: 'project-1',
        policyRevision: '1',
      },
      purpose: 'coding',
      sessionId: 'session-1',
      turnId: `turn:${providerId}`,
    }))
      void _;
    const credentialKind =
      providerId === 'local-openai-compatible'
        ? 'none'
        : providerId === 'openai-codex-subscription'
          ? 'subscription'
          : 'external';
    assert.deepEqual(calls, [
      'grant',
      'prepare',
      `credential:${credentialKind}`,
      `adapter:upstream-model:session-1:turn:${providerId}`,
      'outcome:completed',
    ]);
  }
});
