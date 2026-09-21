import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

function runtimeFixture(directory, { onGenerate = async () => {} } = {}) {
  return createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    generate: async function* () {},
    provider: { id: 'fixture', name: 'Fixture', capabilities: [] },
    auth: {
      token: async () => 'unused',
      status: async () => ({ connected: false }),
    },
    credentialBroker: { resolve: async () => ({ value: undefined }) },
    providerAdapters: createProviderAdapterRegistry({
      'identity-test': () => ({
        async inspectConnection() {
          return { available: true };
        },
        async discoverModels() {
          return [{ id: 'identity-model', name: 'Identity model' }];
        },
        async *generate(input) {
          await onGenerate(input);
          yield {
            type: 'result',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'completed' }],
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          };
        },
      }),
    }),
    runners: { execute: async () => ({}), close: async () => {} },
  });
}

test('security administrators manage tenant-scoped workload and service identities without leaking credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workload-identities-'));
  const runtime = await runtimeFixture(directory);
  t.after(() => runtime.close());
  const client = 'identity-admin-client';
  const command = (action, input = {}, principal) =>
    runtime.command({ action, client, ...input }, principal);

  const acme = await command('createOrganization', {
    slug: 'identity-acme',
    displayName: 'Identity Acme',
    kind: 'enterprise',
  });
  const other = await command('createOrganization', {
    slug: 'identity-other',
    displayName: 'Identity Other',
    kind: 'enterprise',
  });
  const project = await command('saveProject', {
    organizationId: acme.id,
    name: 'Identity platform',
  });
  await command('selectActiveContext', {
    context: { organizationId: acme.id, projectId: project.id },
  });

  const workload = await command('createWorkloadIdentity', {
    organizationId: acme.id,
    displayName: 'Release automation',
  });
  await command('createWorkloadIdentity', {
    organizationId: other.id,
    displayName: 'Other automation',
  });
  const opened = await command('createServicePrincipal', {
    organizationId: acme.id,
    displayName: 'Release CI',
  });
  assert.match(opened.credential, /^svc_/);
  assert.equal('credentialHash' in opened.servicePrincipal, false);

  const snapshot = await runtime.snapshot(undefined, client);
  assert.deepEqual(
    snapshot.workloadIdentities.map((value) => value.id),
    [workload.id],
  );
  assert.deepEqual(
    snapshot.servicePrincipals.map((value) => value.id),
    [opened.servicePrincipal.id],
  );
  assert.equal(JSON.stringify(snapshot).includes('credentialHash'), false);

  const rotated = await command('rotateServicePrincipalCredential', {
    organizationId: acme.id,
    servicePrincipalId: opened.servicePrincipal.id,
    expectedRevision: opened.servicePrincipal.revision,
  });
  await assert.rejects(runtime.identitySessions.authenticate(opened.credential), /not active/);
  const authenticated = await runtime.identitySessions.authenticate(rotated.credential);
  assert.deepEqual(authenticated.principal, {
    kind: 'service-principal',
    servicePrincipalId: opened.servicePrincipal.id,
  });

  await command('createMembership', {
    organizationId: acme.id,
    principal: authenticated.principal,
    scope: { kind: 'organization', organizationId: acme.id },
    roles: ['member'],
  });
  await assert.rejects(
    command(
      'createWorkloadIdentity',
      { organizationId: other.id, displayName: 'Cross-tenant attempt' },
      authenticated.principal,
    ),
    /Not authorized|not active for this organization/,
  );
  const deniedAudit = await command('querySecurityAudit', {
    organizationId: other.id,
    limit: 100,
  });
  assert.equal(
    deniedAudit.records.some(
      (record) =>
        record.resource?.id === 'createWorkloadIdentity' &&
        record.actor.servicePrincipalId === opened.servicePrincipal.id &&
        record.outcome === 'denied',
    ),
    true,
  );

  const revokedServicePrincipal = await command('revokeServicePrincipal', {
    organizationId: acme.id,
    servicePrincipalId: rotated.servicePrincipal.id,
    expectedRevision: rotated.servicePrincipal.revision,
  });
  assert.equal(revokedServicePrincipal.state, 'revoked');
  await assert.rejects(runtime.identitySessions.authenticate(rotated.credential), /not active/);

  const revokedWorkload = await command('revokeWorkloadIdentity', {
    organizationId: acme.id,
    workloadIdentityId: workload.id,
    expectedRevision: workload.revision,
  });
  assert.equal(revokedWorkload.state, 'revoked');

  const audit = await command('querySecurityAudit', { organizationId: acme.id, limit: 100 });
  for (const action of [
    'createWorkloadIdentity',
    'createServicePrincipal',
    'rotateServicePrincipalCredential',
    'revokeServicePrincipal',
    'revokeWorkloadIdentity',
  ]) {
    assert.equal(
      audit.records.some(
        (record) => record.resource?.id === action && record.outcome === 'completed',
      ),
      true,
    );
  }

  const persisted = await readFile(join(directory, 'state.json'), 'utf8');
  assert.equal(persisted.includes(opened.credential), false);
  assert.equal(persisted.includes(rotated.credential), false);
  assert.match(persisted, /credentialHash/);
});

test('revoking a service principal aborts its active model work and invalidates authentication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-service-principal-revocation-'));
  let dispatchStarted;
  const started = new Promise((resolve) => {
    dispatchStarted = resolve;
  });
  const runtime = await runtimeFixture(directory, {
    onGenerate: async ({ signal }) => {
      dispatchStarted();
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.providerOutcome = 'interrupted-known';
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => runtime.close());
  const ownerClient = 'identity-owner-client';
  const command = (client, principal, action, input = {}) =>
    runtime.command({ action, client, ...input }, principal);
  const owner = (action, input) => command(ownerClient, undefined, action, input);

  const organization = await owner('createOrganization', {
    slug: 'revocation-acme',
    displayName: 'Revocation Acme',
    kind: 'enterprise',
  });
  const project = await owner('saveProject', {
    organizationId: organization.id,
    name: 'Release service',
  });
  await owner('selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const connection = await owner('createProviderConnection', {
    organizationId: organization.id,
    providerId: 'identity-test',
    displayName: 'Identity test provider',
    owner: { kind: 'organization', organizationId: organization.id },
    credentialRef: { kind: 'none' },
  });
  const probe = await owner('probeProviderConnection', {
    organizationId: organization.id,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  const route = await owner('createModelRoute', {
    organizationId: organization.id,
    name: 'identity-route',
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
    policy: { fallback: 'never' },
  });
  const opened = await owner('createServicePrincipal', {
    organizationId: organization.id,
    displayName: 'Release CI',
  });
  await owner('createMembership', {
    organizationId: organization.id,
    principal: {
      kind: 'service-principal',
      servicePrincipalId: opened.servicePrincipal.id,
    },
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await owner('createMembership', {
    organizationId: organization.id,
    principal: {
      kind: 'service-principal',
      servicePrincipalId: opened.servicePrincipal.id,
    },
    scope: { kind: 'project', projectId: project.id },
    roles: ['contributor'],
  });
  const authenticated = await runtime.identitySessions.authenticate(opened.credential);
  const principalClient = 'service-principal-client';
  await command(principalClient, authenticated.principal, 'selectActiveContext', {
    context: { organizationId: organization.id, projectId: project.id },
  });
  const conversation = await command(
    principalClient,
    authenticated.principal,
    'createConversation',
    { requestId: 'service-principal-conversation', projectId: project.id },
  );
  await command(principalClient, authenticated.principal, 'claim', {
    sessionId: conversation.sessionId,
  });
  await command(principalClient, authenticated.principal, 'start', {
    sessionId: conversation.sessionId,
    requestId: 'service-principal-turn',
    text: 'Begin governed work.',
    model: route.id,
  });
  await started;

  await owner('revokeServicePrincipal', {
    organizationId: organization.id,
    servicePrincipalId: opened.servicePrincipal.id,
    expectedRevision: opened.servicePrincipal.revision,
  });

  await assert.rejects(runtime.identitySessions.authenticate(opened.credential), /not active/);
  const session = (await runtime.snapshot(conversation.sessionId, ownerClient)).sessions[0];
  assert.equal(session.status, 'interrupted');
  assert.equal(
    session.events.some((event) => event.type === 'identity_authority_revoked'),
    true,
  );
});
