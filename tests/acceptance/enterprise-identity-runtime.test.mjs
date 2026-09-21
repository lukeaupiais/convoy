import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

const providerAuth = {
  token: async () => 'fixture-provider-token',
  status: async () => ({ source: 'fixture', connected: true, device: { state: 'idle' } }),
};

test('enterprise deprovisioning revokes sessions, contexts, queued turns, and active dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-enterprise-identity-'));
  const provisioningEvidence = Object.freeze({ source: 'verified-fake-idp' });
  let observedDomainChallenge;
  let providerDispatches = 0;
  let notifyStarted;
  const firstStarted = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const assertion = {
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    subject: 'employee-42',
    displayName: 'Ada Operator',
    email: 'ada@acme.example',
    emailVerified: true,
    authenticationStrength: 'urn:acme:strong',
    mfa: true,
    source: 'jit',
    externalGroupIds: [],
    evidence: provisioningEvidence,
  };
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'personal-fixture' }],
    generate: async function* () {
      assert.fail('Personal provider must not be used by the enterprise context.');
    },
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth: providerAuth,
    runners: { execute: async () => ({}), close: async () => {} },
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    providerAdapters: createProviderAdapterRegistry({
      'enterprise-fixture': () => ({
        protocol: 'openai-compatible',
        capabilities: ['streaming', 'tool-calls'],
        inspectConnection: async () => ({ available: true }),
        discoverModels: async () => [
          { id: 'enterprise-coder', name: 'Enterprise Coder', input: ['text'] },
        ],
        async *generate({ signal }) {
          providerDispatches += 1;
          notifyStarted();
          await new Promise((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', resolve, { once: true });
          });
          if (signal.aborted) throw new Error('Stopped');
        },
      }),
    }),
    enterpriseIdentity: {
      authorizeProvisioning: async ({ evidence }) => evidence === provisioningEvidence,
      verifyDomainControl: async () => observedDomainChallenge,
      resolveLogin: async () => assertion,
      resolveDeprovisioning: async () => ({
        issuer: assertion.issuer,
        subject: assertion.subject,
        evidence: provisioningEvidence,
      }),
    },
    deployment: {
      id: 'dep_enterprise',
      displayName: 'Enterprise Convoy',
      issuer: 'https://convoy.acme.example',
      publicOrigin: 'https://convoy.acme.example',
      capabilities: ['organizations', 'enterprise-identity'],
      authenticationMethods: ['oidc-pkce'],
    },
  });
  t.after(() => runtime.close());
  const adminClient = 'enterprise-admin';
  const admin = (action, input = {}) => runtime.command({ action, client: adminClient, ...input });

  const organization = await admin('createOrganization', {
    slug: 'acme',
    displayName: 'Acme Corp',
    kind: 'enterprise',
  });
  const project = await admin('saveProject', {
    organizationId: organization.id,
    name: 'Payments',
  });
  await admin('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const pendingDomain = await admin('beginOrganizationDomainVerification', {
    organizationId: organization.id,
    domain: 'acme.example',
  });
  observedDomainChallenge = pendingDomain.challenge;
  await admin('completeOrganizationDomainVerification', {
    organizationId: organization.id,
    domainVerificationId: pendingDomain.verification.id,
  });
  const identityProvider = await admin('configureEnterpriseIdentityProvider', {
    organizationId: organization.id,
    protocol: 'oidc',
    issuer: assertion.issuer,
    displayName: 'Acme SSO',
    verifiedDomains: ['acme.example'],
    jit: { enabled: true, defaultRoles: ['admin'] },
    scimEnabled: true,
    requiredAuthenticationStrength: 'urn:acme:strong',
    requireMfa: true,
  });
  const connection = await admin('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'enterprise-fixture',
    displayName: 'Enterprise fixture',
    owner: { kind: 'organization', organizationId: organization.id },
    credentialRef: { kind: 'none' },
  });
  const probe = await admin('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await admin('createModelRoute', {
    organizationId: organization.id,
    name: 'enterprise-coding',
    purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
    policy: { fallback: 'never' },
  });

  const login = await runtime.identitySessions.login({
    organizationId: organization.id,
    identityProviderId: identityProvider.id,
    deviceId: 'ada-laptop',
    request: { authorizationCode: 'deterministic-fake-code' },
  });
  const authenticated = await runtime.identitySessions.authenticate(login.credential);
  const userClient = 'ada-workstation';
  const user = (action, input = {}) =>
    runtime.command({ action, client: userClient, ...input }, authenticated.principal);
  await user('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  await assert.rejects(
    user('beginOrganizationDomainVerification', {
      organizationId: organization.id,
      domain: 'unauthorized.example',
    }),
    /Not authorized/,
  );
  const safeSnapshot = await runtime.snapshot(undefined, userClient, authenticated.principal);
  assert.equal(safeSnapshot.identityProviders[0].id, identityProvider.id);
  assert.equal(JSON.stringify(safeSnapshot).includes('challengeHash'), false);
  assert.equal(JSON.stringify(safeSnapshot).includes('verified-fake-idp'), false);

  const conversations = [];
  const desired = safeSnapshot.scheduler.maxConcurrent + 1;
  for (let index = 0; index < desired; index += 1) {
    const conversation = await user('createConversation', {
      requestId: `enterprise-chat-${index}`,
      projectId: project.id,
    });
    conversations.push(conversation);
    await user('claim', { sessionId: conversation.sessionId });
    await user('sendMessage', {
      sessionId: conversation.sessionId,
      requestId: `enterprise-turn-${index}`,
      text: 'Do governed work.',
      model: route.id,
      mode: 'queue',
    });
  }
  await firstStarted;
  await until(() => providerDispatches === safeSnapshot.scheduler.maxConcurrent);

  await admin('deprovisionExternalIdentity', {
    organizationId: organization.id,
    identityProviderId: identityProvider.id,
    request: { externalSubject: assertion.subject },
  });

  await assert.rejects(
    runtime.identitySessions.authenticate(login.credential),
    /Device session is not active/,
  );
  await assert.rejects(
    user('selectActiveContext', {
      context: { organizationId: organization.id, projectId: project.id },
    }),
    /Context is not available|Not authorized/,
  );
  const after = await runtime.snapshot(undefined, adminClient);
  const affected = after.sessions.filter((session) =>
    conversations.some((conversation) => conversation.sessionId === session.id),
  );
  assert.equal(affected.length, desired);
  assert.ok(affected.every((session) => session.status === 'interrupted'));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(providerDispatches, safeSnapshot.scheduler.maxConcurrent);
});

async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}
