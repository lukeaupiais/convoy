import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../../apps/daemon/src/modules/providers/index.mjs';

test('subscription compatibility seeds stable model aliases without storing OAuth material', async () => {
  const state = {};
  const providers = createProviders({ state });
  const input = {
    organizationId: 'personal',
    userId: 'local',
    providerId: 'openai-codex-subscription',
    displayName: 'ChatGPT subscription',
    credentialRef: { kind: 'subscription', reference: 'chatgpt-oauth', version: '1' },
    models: [{ id: 'gpt-existing-selection', name: 'Existing', input: ['text'] }],
  };
  await providers.administration.ensureSubscriptionCompatibility(input);
  await providers.administration.ensureSubscriptionCompatibility(input);

  assert.equal(state.providerConnections.length, 1);
  assert.equal(state.modelOfferings.length, 1);
  assert.equal(state.modelRoutes.length, 1);
  assert.equal(state.modelRoutes[0].id, 'gpt-existing-selection');
  assert.equal(state.modelOfferings[0].upstreamModelId, 'gpt-existing-selection');
  assert.deepEqual(state.providerConnections[0].credentialRef, {
    kind: 'subscription',
    reference: 'chatgpt-oauth',
    version: '1',
  });
  assert.equal(JSON.stringify(state).includes('access_token'), false);
  assert.equal(JSON.stringify(state).includes('refresh_token'), false);
});

function harness() {
  let sequence = 0;
  const state = {
    providerConnections: [],
    providerProbeEvidence: [],
    modelOfferings: [],
    modelRoutes: [],
    providerGrants: [],
    providerOutcomes: [],
  };
  const events = [];
  const providers = createProviders({
    state,
    now: () => '2026-09-20T12:00:00.000Z',
    createId: (prefix) => `${prefix}_${++sequence}`,
    save: async () => {},
    event: (value) => events.push(value),
  });
  return { state, events, providers };
}

test('provider administration creates tenant-scoped connections with exactly one owner scope', async () => {
  const { providers } = harness();
  const connection = await providers.administration.createConnection({
    organizationId: 'org_acme',
    providerId: 'openai',
    displayName: 'Acme OpenAI',
    owner: { kind: 'team', teamId: 'team_platform' },
    credentialRef: { kind: 'external', reference: 'vault://providers/openai' },
    governance: { allowedProjectIds: ['project_api'] },
  });

  assert.equal(connection.state, 'pending');
  assert.equal(connection.owner.teamId, 'team_platform');
  assert.match(connection.revision, /^sha256:/);
  assert.equal('credential' in connection, false);
  await assert.rejects(
    providers.administration.createConnection({
      organizationId: 'org_acme',
      providerId: 'openai',
      displayName: 'Broken',
      owner: { kind: 'team', teamId: 'team_platform', userId: 'user_1' },
      credentialRef: { kind: 'external', reference: 'vault://broken' },
    }),
    /exactly one owner scope/,
  );
  await assert.rejects(
    providers.administration.createConnection({
      organizationId: 'org_acme',
      providerId: 'openai',
      displayName: 'Leaky',
      owner: { kind: 'user', userId: 'user_1' },
      credentialRef: { kind: 'api-key', value: 'plaintext-must-not-be-stored' },
    }),
    /secret reference/,
  );
});

test('probe evidence publishes only observed offerings and advances the connection revision', async () => {
  const { providers, state } = harness();
  const connection = await providers.administration.createConnection({
    organizationId: 'org_acme',
    providerId: 'gateway',
    displayName: 'EU gateway',
    owner: { kind: 'organization', organizationId: 'org_acme' },
    credentialRef: { kind: 'external', reference: 'vault://gateway' },
  });
  const result = await providers.administration.recordProbe({
    organizationId: 'org_acme',
    connectionId: connection.id,
    expectedRevision: connection.revision,
    evidence: { status: 'ready', source: 'active-probe', requestId: 'probe-request-1' },
    offerings: [
      {
        upstreamModelId: 'private-coder',
        displayName: 'Private Coder',
        availability: 'available',
        verifiedCapabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          toolCalls: 'parallel',
          structuredOutput: true,
          reasoning: true,
          streaming: true,
          dataResidencies: ['eu'],
        },
      },
    ],
  });

  assert.equal(result.connection.state, 'ready');
  assert.notEqual(result.connection.revision, connection.revision);
  assert.equal(result.offerings[0].providerConnectionId, connection.id);
  assert.match(result.offerings[0].catalogRevision, /^sha256:/);
  assert.equal(state.providerProbeEvidence.length, 1);
  await assert.rejects(
    providers.administration.recordProbe({
      organizationId: 'org_acme',
      connectionId: connection.id,
      expectedRevision: connection.revision,
      evidence: { status: 'ready' },
      offerings: [],
    }),
    /revision changed/,
  );
});

async function readyConnection(providers, input, offering) {
  const connection = await providers.administration.createConnection(input);
  return providers.administration.recordProbe({
    organizationId: input.organizationId,
    connectionId: connection.id,
    expectedRevision: connection.revision,
    evidence: { status: 'ready', source: 'active-probe' },
    offerings: [offering],
  });
}

test('model routing deterministically resolves policy-compliant candidates into an immutable idempotent grant', async () => {
  const { providers } = harness();
  const us = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'direct',
      displayName: 'US',
      owner: { kind: 'organization', organizationId: 'org_acme' },
      credentialRef: { kind: 'external', reference: 'vault://us' },
    },
    {
      upstreamModelId: 'coder-us',
      displayName: 'Coder US',
      availability: 'available',
      estimatedCostUsd: 0.1,
      verifiedCapabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        toolCalls: 'parallel',
        structuredOutput: true,
        reasoning: true,
        streaming: true,
        dataResidencies: ['us'],
      },
    },
  );
  const eu = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'self-hosted',
      displayName: 'EU',
      owner: { kind: 'team', teamId: 'team_platform' },
      credentialRef: { kind: 'external', reference: 'vault://eu' },
      governance: { allowedProjectIds: ['project_api'] },
    },
    {
      upstreamModelId: 'coder-eu',
      displayName: 'Coder EU',
      availability: 'available',
      estimatedCostUsd: 0.2,
      verifiedCapabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        toolCalls: 'parallel',
        structuredOutput: true,
        reasoning: true,
        streaming: true,
        dataResidencies: ['eu'],
      },
    },
  );
  const route = await providers.administration.createRoute({
    organizationId: 'org_acme',
    name: 'private-eu',
    purposes: ['coding'],
    candidates: [
      { connectionId: us.connection.id, offeringId: us.offerings[0].id },
      { connectionId: eu.connection.id, offeringId: eu.offerings[0].id },
    ],
    policy: {
      allowedResidencies: ['eu'],
      maximumEstimatedCostUsdPerTurn: 0.3,
      fallback: 'not-sent-or-rejected',
      grantTtlMs: 60_000,
    },
  });
  const request = {
    context: {
      organizationId: 'org_acme',
      userId: 'user_1',
      teamId: 'team_platform',
      projectId: 'project_api',
      policyRevision: 'policy_7',
    },
    routeId: route.id,
    purpose: 'coding',
    sessionId: 'session_1',
    turnId: 'turn_1',
    constraints: {
      requiredCapabilities: { reasoning: true, toolCalls: 'parallel' },
      remainingBudgetUsd: 1,
    },
  };

  const grant = await providers.routing.resolveGrant(request);
  const replay = await providers.routing.resolveGrant(request);
  assert.equal(grant.providerConnectionId, eu.connection.id);
  assert.equal(grant.modelOfferingId, eu.offerings[0].id);
  assert.equal(grant.routeRevision, route.revision);
  assert.equal(grant.connectionRevision, eu.connection.revision);
  assert.equal(grant.policyRevision, 'policy_7');
  assert.equal(grant.expiresAt, '2026-09-20T12:01:00.000Z');
  assert.match(grant.digest, /^sha256:/);
  assert.deepEqual(replay, grant);
  assert.deepEqual(await providers.routing.describeRoute(request.context, route.id), {
    id: route.id,
    name: 'private-eu',
    input: ['text'],
  });
  const dispatch = await providers.routing.prepareDispatch(grant.id, {
    policyRevision: 'policy_7',
  });
  assert.equal(dispatch.grant.digest, grant.digest);
  assert.equal(dispatch.connection.id, eu.connection.id);
  assert.equal(dispatch.offering.upstreamModelId, 'coder-eu');
  assert.equal('value' in dispatch.connection.credentialRef, false);
});

test('uncertain provider outcomes block fallback and connection revocation invalidates queued dispatch', async () => {
  const { providers } = harness();
  const ready = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'direct',
      displayName: 'Direct',
      owner: { kind: 'user', userId: 'user_1' },
      credentialRef: { kind: 'external', reference: 'vault://direct' },
    },
    {
      upstreamModelId: 'coder',
      displayName: 'Coder',
      availability: 'available',
      estimatedCostUsd: 0.1,
      verifiedCapabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        toolCalls: 'parallel',
        structuredOutput: true,
        reasoning: true,
        streaming: true,
        dataResidencies: ['eu'],
      },
    },
  );
  const route = await providers.administration.createRoute({
    organizationId: 'org_acme',
    name: 'coding',
    purposes: ['coding'],
    candidates: [{ connectionId: ready.connection.id, offeringId: ready.offerings[0].id }],
    policy: { fallback: 'not-sent-or-rejected', grantTtlMs: 60_000 },
  });
  const grant = await providers.routing.resolveGrant({
    context: {
      organizationId: 'org_acme',
      userId: 'user_1',
      projectId: 'project_api',
      policyRevision: 'policy_1',
    },
    routeId: route.id,
    purpose: 'coding',
    sessionId: 'session_1',
    turnId: 'turn_1',
  });

  const outcome = await providers.routing.recordOutcome(grant.id, {
    classification: 'uncertain',
    providerRequestId: 'provider-request-1',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      upstreamCostUsd: 0.08,
      gatewayCostUsd: 0.01,
      costUsd: 0.09,
    },
  });
  assert.equal(outcome.fallbackAllowed, false);
  assert.equal(outcome.reconciliationRequired, true);
  await assert.rejects(
    providers.routing.recordOutcome(grant.id, { classification: 'completed' }),
    /already has terminal outcome/,
  );

  const revoked = await providers.administration.revokeConnection({
    organizationId: 'org_acme',
    connectionId: ready.connection.id,
    expectedRevision: ready.connection.revision,
    reason: 'credential-compromised',
  });
  assert.equal(revoked.state, 'revoked');
  await assert.rejects(providers.routing.prepareDispatch(grant.id), /uncertain|revoked|changed/);
});

test('route resolution enforces cumulative domain budget constraints', async () => {
  const { providers } = harness();
  const ready = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'direct',
      displayName: 'Budgeted',
      owner: { kind: 'organization', organizationId: 'org_acme' },
      credentialRef: { kind: 'external', reference: 'vault://budgeted' },
    },
    {
      upstreamModelId: 'coder',
      displayName: 'Coder',
      availability: 'available',
      estimatedCostUsd: 0.1,
      verifiedCapabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        toolCalls: 'parallel',
        structuredOutput: true,
        reasoning: true,
        streaming: true,
      },
    },
  );
  const route = await providers.administration.createRoute({
    organizationId: 'org_acme',
    name: 'budgeted',
    purposes: ['coding'],
    candidates: [{ connectionId: ready.connection.id, offeringId: ready.offerings[0].id }],
    policy: { budget: { organizationUsd: 0.15 } },
  });
  const base = {
    context: {
      organizationId: 'org_acme',
      userId: 'user_1',
      projectId: 'project_api',
      policyRevision: 'policy_1',
    },
    routeId: route.id,
    purpose: 'coding',
    sessionId: 'session_1',
  };
  const first = await providers.routing.resolveGrant({ ...base, turnId: 'turn_1' });
  await providers.routing.recordOutcome(first.id, {
    classification: 'completed',
    usage: { costUsd: 0.1 },
  });
  await assert.rejects(providers.routing.resolveGrant({ ...base, turnId: 'turn_2' }), /budget/);
});

test('fallback issues a separate pinned grant only after policy-approved safe outcomes', async () => {
  const { providers, state } = harness();
  const first = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'direct',
      displayName: 'Direct',
      owner: { kind: 'user', userId: 'user_1' },
      credentialRef: { kind: 'none' },
    },
    {
      upstreamModelId: 'first',
      displayName: 'First',
      availability: 'available',
      verifiedCapabilities: { streaming: true },
    },
  );
  const second = await readyConnection(
    providers,
    {
      organizationId: 'org_acme',
      providerId: 'gateway',
      displayName: 'Gateway',
      owner: { kind: 'user', userId: 'user_1' },
      credentialRef: { kind: 'none' },
    },
    {
      upstreamModelId: 'second',
      displayName: 'Second',
      availability: 'available',
      verifiedCapabilities: { streaming: true },
    },
  );
  const route = await providers.administration.createRoute({
    organizationId: 'org_acme',
    name: 'safe-fallback',
    purposes: ['coding'],
    candidates: [
      { connectionId: first.connection.id, offeringId: first.offerings[0].id },
      { connectionId: second.connection.id, offeringId: second.offerings[0].id },
    ],
    policy: { fallback: 'not-sent-or-rejected', grantTtlMs: 60_000 },
  });
  const grant = await providers.routing.resolveGrant({
    context: {
      organizationId: 'org_acme',
      userId: 'user_1',
      projectId: 'project_api',
      policyRevision: 'policy_1',
    },
    routeId: route.id,
    purpose: 'coding',
    sessionId: 'session_1',
    turnId: 'turn_1',
  });
  await providers.routing.recordOutcome(grant.id, { classification: 'rejected' });
  const fallback = await providers.routing.resolveFallbackGrant(grant.id);

  assert.notEqual(fallback.id, grant.id);
  assert.equal(fallback.previousGrantId, grant.id);
  assert.equal(fallback.attempt, 2);
  assert.equal(fallback.providerConnectionId, second.connection.id);
  assert.equal(state.providerOutcomes[0].grantId, grant.id);
  assert.match(fallback.digest, /^sha256:/);

  await providers.routing.recordOutcome(fallback.id, { classification: 'uncertain' });
  await assert.rejects(providers.routing.resolveFallbackGrant(fallback.id), /not permitted/);
});
