import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../../apps/daemon/src/modules/identity/index.mjs';

function fixture() {
  let nextId = 0;
  const state = {};
  return {
    state,
    identity: createIdentity({
      state,
      save: async () => {},
      generateId: (prefix) => `${prefix}_${++nextId}`,
      now: () => new Date('2026-09-20T12:00:00.000Z'),
      authorizeAccountLink: async ({ proof }) => proof === 'verified-current-session',
    }),
  };
}

test('Identity provisions and resolves a federated subject without trusting email as identity', async () => {
  const { identity, state } = fixture();
  const provisioned = await identity.provisionExternalUser({
    organizationId: 'org_acme',
    identityProviderId: 'idp_acme',
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    subject: 'employee-42',
    displayName: 'Ada Operator',
    email: 'ada@acme.example',
    emailVerified: true,
    source: 'jit',
  });

  assert.equal(provisioned.created, true);
  assert.equal(provisioned.user.primaryEmail, 'ada@acme.example');
  assert.equal(state.identity.externalIdentityLinks[0].email, 'ada@acme.example');
  assert.equal(state.identity.externalIdentityLinks[0].state, 'active');
  assert.deepEqual(
    await identity.resolveExternalIdentity({
      identityProviderId: 'idp_acme',
      issuer: 'https://login.acme.example',
      subject: 'employee-42',
      authenticationStrength: 'urn:acme:strong',
      mfa: true,
    }),
    {
      principal: { kind: 'user', userId: provisioned.user.id },
      link: provisioned.link,
      authentication: {
        method: 'oidc-pkce',
        authenticationStrength: 'urn:acme:strong',
        mfa: true,
      },
    },
  );

  const existing = await identity.provisionExternalUser({
    organizationId: 'org_acme',
    identityProviderId: 'idp_acme',
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    subject: 'employee-42',
    displayName: 'Changed upstream name',
    email: 'ada@acme.example',
    emailVerified: true,
    source: 'scim',
  });
  assert.equal(existing.created, false);
  assert.equal(existing.user.id, provisioned.user.id);
});

test('Identity requires controlled linking when a federated email matches an existing account', async () => {
  const { identity } = fixture();
  const user = await identity.createUser({
    displayName: 'Existing Ada',
    primaryEmail: 'ada@acme.example',
    primaryEmailVerified: true,
  });

  await assert.rejects(
    identity.provisionExternalUser({
      organizationId: 'org_acme',
      identityProviderId: 'idp_acme',
      protocol: 'saml',
      issuer: 'https://sso.acme.example',
      subject: 'employee-42',
      displayName: 'Ada',
      email: 'ada@acme.example',
      emailVerified: true,
      source: 'jit',
    }),
    /Controlled account linking is required/,
  );

  await assert.rejects(
    identity.linkExternalIdentity({
      userId: user.id,
      organizationId: 'org_acme',
      identityProviderId: 'idp_acme',
      protocol: 'saml',
      issuer: 'https://sso.acme.example',
      subject: 'employee-42',
      email: 'ada@acme.example',
      emailVerified: true,
      proof: 'unverified',
    }),
    /Account linking was not authorized/,
  );
  const link = await identity.linkExternalIdentity({
    userId: user.id,
    organizationId: 'org_acme',
    identityProviderId: 'idp_acme',
    protocol: 'saml',
    issuer: 'https://sso.acme.example',
    subject: 'employee-42',
    email: 'ada@acme.example',
    emailVerified: true,
    proof: 'verified-current-session',
  });
  assert.equal(link.userId, user.id);
});

test('Identity deprovisioning revokes the organization link and all live device sessions', async () => {
  const { identity } = fixture();
  const provisioned = await identity.provisionExternalUser({
    organizationId: 'org_acme',
    identityProviderId: 'idp_acme',
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    subject: 'employee-42',
    displayName: 'Ada',
    email: 'ada@acme.example',
    emailVerified: true,
    source: 'scim',
  });
  const session = await identity.openDeviceSession({
    userId: provisioned.user.id,
    deviceId: 'managed-laptop',
    ttlMs: 60_000,
  });
  await identity.deprovisionExternalIdentity({
    organizationId: 'org_acme',
    identityProviderId: 'idp_acme',
    subject: 'employee-42',
  });
  await assert.rejects(
    identity.resolveExternalIdentity({
      identityProviderId: 'idp_acme',
      issuer: 'https://login.acme.example',
      subject: 'employee-42',
    }),
    /External identity is not active/,
  );
  await assert.rejects(
    identity.authenticateDeviceSession(session.credential),
    /Device session is not active/,
  );
});
