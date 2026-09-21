import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../../apps/daemon/src/modules/identity/index.mjs';

function fixture() {
  let nextId = 0;
  let now = Date.parse('2026-09-20T12:00:00.000Z');
  const state = {};
  const identity = createIdentity({
    state,
    save: async () => {},
    generateId: (prefix) => `${prefix}_${++nextId}`,
    now: () => new Date(now),
  });
  return {
    identity,
    state,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test('Identity binds a revocable device credential to one active user without persisting the secret', async () => {
  const { identity, state } = fixture();
  const user = await identity.createUser({
    displayName: 'Luke',
    primaryEmail: 'luke@example.com',
    primaryEmailVerified: true,
  });
  assert.equal(
    await identity.getVerifiedEmail({ kind: 'user', userId: user.id }),
    'luke@example.com',
  );
  const opened = await identity.openDeviceSession({
    userId: user.id,
    deviceId: 'laptop',
    ttlMs: 60_000,
  });

  assert.equal(opened.session.userId, user.id);
  assert.match(opened.credential, /^dvc_/);
  assert.equal(state.identity.deviceSessions[0].credential, undefined);
  assert.notEqual(state.identity.deviceSessions[0].credentialHash, opened.credential);
  assert.deepEqual(await identity.authenticateDeviceSession(opened.credential), {
    kind: 'user',
    userId: user.id,
  });

  await identity.revokeDeviceSession(opened.session.id);
  await assert.rejects(
    identity.authenticateDeviceSession(opened.credential),
    /Device session is not active/,
  );
});

test('Identity rejects expired device sessions and immediately blocks sessions for suspended users', async () => {
  const { identity, advance } = fixture();
  const user = await identity.createUser({ displayName: 'Operator' });
  const expired = await identity.openDeviceSession({
    userId: user.id,
    deviceId: 'short-lived',
    ttlMs: 10,
  });
  advance(11);
  await assert.rejects(identity.authenticateDeviceSession(expired.credential), /expired/);

  const current = await identity.openDeviceSession({
    userId: user.id,
    deviceId: 'desktop',
    ttlMs: 60_000,
  });
  await identity.setUserState(user.id, 'suspended');
  await assert.rejects(
    identity.authenticateDeviceSession(current.credential),
    /User is not active/,
  );
});

test('Identity resolves independently revocable workload identities without treating them as users', async () => {
  const { identity } = fixture();
  const workload = await identity.createWorkloadIdentity({
    displayName: 'release automation',
    organizationId: 'org_acme',
  });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };

  assert.deepEqual(await identity.assertPrincipalActive(principal), principal);
  await assert.rejects(
    identity.assertPrincipalActive(principal, { organizationId: 'org_other' }),
    /not active for this organization/,
  );
  await identity.setWorkloadIdentityState(workload.id, 'revoked');
  await assert.rejects(
    identity.assertPrincipalActive(principal),
    /Workload identity is not active/,
  );
});

test('Identity issues a secret-once organization service principal credential and revokes it', async () => {
  const { identity, state } = fixture();
  const opened = await identity.createServicePrincipal({
    displayName: 'CI release',
    organizationId: 'org_acme',
  });
  assert.match(opened.credential, /^svc_/);
  assert.equal(state.identity.servicePrincipals[0].credential, undefined);
  assert.deepEqual(await identity.authenticateServicePrincipal(opened.credential), {
    kind: 'service-principal',
    servicePrincipalId: opened.servicePrincipal.id,
  });
  await identity.setServicePrincipalState(opened.servicePrincipal.id, 'revoked');
  await assert.rejects(identity.authenticateServicePrincipal(opened.credential), /not active/);
});

test('Identity rotates service-principal credentials atomically and checks tenant revision', async () => {
  const { identity, state, advance } = fixture();
  const opened = await identity.createServicePrincipal({
    displayName: 'CI release',
    organizationId: 'org_acme',
  });

  const rotated = await identity.rotateServicePrincipalCredential({
    organizationId: 'org_acme',
    servicePrincipalId: opened.servicePrincipal.id,
    expectedRevision: opened.servicePrincipal.revision,
    ttlMs: 10,
  });

  assert.match(rotated.credential, /^svc_/);
  assert.notEqual(rotated.credential, opened.credential);
  assert.equal(rotated.servicePrincipal.revision, 2);
  assert.equal(state.identity.servicePrincipals[0].credential, undefined);
  assert.notEqual(state.identity.servicePrincipals[0].credentialHash, rotated.credential);
  await assert.rejects(identity.authenticateServicePrincipal(opened.credential), /not active/);
  assert.deepEqual(await identity.authenticateServicePrincipal(rotated.credential), {
    kind: 'service-principal',
    servicePrincipalId: opened.servicePrincipal.id,
  });
  await assert.rejects(
    identity.rotateServicePrincipalCredential({
      organizationId: 'org_other',
      servicePrincipalId: opened.servicePrincipal.id,
      expectedRevision: rotated.servicePrincipal.revision,
    }),
    /not found/,
  );
  await assert.rejects(
    identity.rotateServicePrincipalCredential({
      organizationId: 'org_acme',
      servicePrincipalId: opened.servicePrincipal.id,
      expectedRevision: 1,
    }),
    /revision conflict/,
  );
  advance(11);
  await assert.rejects(
    identity.authenticateServicePrincipal(rotated.credential),
    /credential has expired/,
  );
});

test('Identity exposes tenant-bounded administrative inventory without credential digests', async () => {
  const { identity } = fixture();
  await identity.createWorkloadIdentity({
    displayName: 'release automation',
    organizationId: 'org_acme',
  });
  await identity.createWorkloadIdentity({
    displayName: 'other automation',
    organizationId: 'org_other',
  });
  await identity.createServicePrincipal({
    displayName: 'CI release',
    organizationId: 'org_acme',
  });

  const snapshot = identity.snapshot(undefined, {
    organizationId: 'org_acme',
    includeAdministration: true,
  });
  assert.deepEqual(
    snapshot.workloadIdentities.map((value) => value.displayName),
    ['release automation'],
  );
  assert.deepEqual(
    snapshot.servicePrincipals.map((value) => value.displayName),
    ['CI release'],
  );
  assert.equal(JSON.stringify(snapshot).includes('credentialHash'), false);
  assert.deepEqual(identity.snapshot(undefined, { organizationId: 'org_acme' }), {
    deviceSessions: [],
  });
});

test('Identity fails closed for a persisted service credential without bounded expiry', async () => {
  const { identity, state } = fixture();
  const opened = await identity.createServicePrincipal({
    displayName: 'Legacy automation',
    organizationId: 'org_acme',
  });
  delete state.identity.servicePrincipals[0].credentialExpiresAt;

  await assert.rejects(
    identity.authenticateServicePrincipal(opened.credential),
    /credential has expired/,
  );
});
