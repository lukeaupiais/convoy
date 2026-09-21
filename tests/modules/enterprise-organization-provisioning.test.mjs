import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizations } from '../../apps/daemon/src/modules/organizations/index.mjs';

function fixture() {
  let nextId = 0;
  const state = {};
  const users = new Set(['usr_owner', 'usr_ada']);
  const authority = Object.freeze({ verifiedBy: 'fake-enterprise-adapter' });
  const organizations = createOrganizations({
    state,
    deploymentId: 'dep_local',
    save: async () => {},
    generateId: (prefix) => `${prefix}_${++nextId}`,
    now: () => new Date('2026-09-20T12:00:00.000Z'),
    assertPrincipalActive: async (principal) => {
      if (principal?.kind !== 'user' || !users.has(principal.userId)) throw new Error('inactive');
      return principal;
    },
    authorizeProvisioning: async ({ evidence }) => evidence === authority,
    verifyDomainControl: async ({ evidence }) => evidence?.observedChallenge,
    projects: {
      listByOrganization: async (organizationId) =>
        organizationId === 'org_1'
          ? [
              {
                id: 'prj_payments',
                organizationId: 'org_1',
                teamId: 'team_3',
                slug: 'payments',
                displayName: 'Payments',
              },
            ]
          : [],
      get: async (organizationId, projectId) =>
        organizationId === 'org_1' && projectId === 'prj_payments'
          ? {
              id: 'prj_payments',
              organizationId: 'org_1',
              teamId: 'team_3',
              slug: 'payments',
              displayName: 'Payments',
            }
          : undefined,
    },
  });
  return {
    state,
    organizations,
    owner: { kind: 'user', userId: 'usr_owner' },
    ada: { kind: 'user', userId: 'usr_ada' },
    authority,
  };
}

async function enterprise(value) {
  const organization = await value.organizations.createOrganization({
    slug: 'acme',
    displayName: 'Acme Corp',
    kind: 'enterprise',
    owner: value.owner,
  });
  const team = await value.organizations.createTeam({
    actor: value.owner,
    organizationId: organization.id,
    slug: 'platform',
    displayName: 'Platform',
  });
  return { organization, team };
}

async function verifyAcmeDomain(value, organizationId) {
  const pending = await value.organizations.beginDomainVerification({
    actor: value.owner,
    organizationId,
    domain: 'acme.example',
  });
  return value.organizations.completeDomainVerification({
    organizationId,
    domainVerificationId: pending.verification.id,
    evidence: { observedChallenge: pending.challenge },
  });
}

test('Organization domains require adapter-verified control before identity-provider use', async () => {
  const value = fixture();
  const { organization } = await enterprise(value);
  await assert.rejects(
    value.organizations.configureIdentityProvider({
      actor: value.owner,
      organizationId: organization.id,
      protocol: 'oidc',
      issuer: 'https://login.acme.example',
      displayName: 'Acme SSO',
      verifiedDomains: ['acme.example'],
      jit: { enabled: true, defaultRoles: ['member'] },
      scimEnabled: true,
    }),
    /Domain control has not been verified/,
  );
  const verification = await verifyAcmeDomain(value, organization.id);
  assert.equal(verification.state, 'verified');
  assert.equal(value.state.organizations.domainVerifications[0].challenge, undefined);
});

test('Organizations enforce verified domains and authentication strength before JIT', async () => {
  const value = fixture();
  const { organization } = await enterprise(value);
  await verifyAcmeDomain(value, organization.id);
  const provider = await value.organizations.configureIdentityProvider({
    actor: value.owner,
    organizationId: organization.id,
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    displayName: 'Acme SSO',
    verifiedDomains: ['acme.example'],
    jit: { enabled: true, defaultRoles: ['member'] },
    scimEnabled: true,
    requiredAuthenticationStrength: 'urn:acme:strong',
    requireMfa: true,
  });

  await assert.rejects(
    value.organizations.evaluateFederatedAccess({
      organizationId: organization.id,
      identityProviderId: provider.id,
      email: 'ada@outside.example',
      emailVerified: true,
      authenticationStrength: 'urn:acme:strong',
      mfa: true,
    }),
    /verified organization domain/,
  );
  await assert.rejects(
    value.organizations.evaluateFederatedAccess({
      organizationId: organization.id,
      identityProviderId: provider.id,
      email: 'ada@acme.example',
      emailVerified: true,
      authenticationStrength: 'urn:acme:weak',
      mfa: false,
    }),
    /authentication strength/,
  );
  assert.deepEqual(
    await value.organizations.evaluateFederatedAccess({
      organizationId: organization.id,
      identityProviderId: provider.id,
      email: 'ada@acme.example',
      emailVerified: true,
      authenticationStrength: 'urn:acme:strong',
      mfa: true,
    }),
    {
      organizationId: organization.id,
      identityProviderId: provider.id,
      provisioning: 'jit',
      defaultRoles: ['member'],
    },
  );
});

test('SCIM reconciliation owns only mapped memberships and removes stale group authority', async () => {
  const value = fixture();
  const { organization, team } = await enterprise(value);
  await verifyAcmeDomain(value, organization.id);
  const provider = await value.organizations.configureIdentityProvider({
    actor: value.owner,
    organizationId: organization.id,
    protocol: 'saml',
    issuer: 'https://sso.acme.example',
    displayName: 'Acme SSO',
    verifiedDomains: ['acme.example'],
    jit: { enabled: false, defaultRoles: ['member'] },
    scimEnabled: true,
    requireMfa: false,
  });
  await value.organizations.saveIdentityProviderGroupMapping({
    actor: value.owner,
    organizationId: organization.id,
    identityProviderId: provider.id,
    externalGroupId: 'platform-engineers',
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });
  const manual = await value.organizations.createMembership({
    actor: value.owner,
    organizationId: organization.id,
    principal: value.ada,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['viewer'],
  });

  const first = await value.organizations.reconcileProvisionedMemberships({
    organizationId: organization.id,
    identityProviderId: provider.id,
    principal: value.ada,
    source: 'scim',
    externalGroupIds: ['platform-engineers'],
    evidence: value.authority,
  });
  assert.equal(first.managedMemberships.length, 1);
  assert.equal(first.managedMemberships[0].scope.teamId, team.id);
  assert.equal(first.managedMemberships[0].state, 'active');

  const second = await value.organizations.reconcileProvisionedMemberships({
    organizationId: organization.id,
    identityProviderId: provider.id,
    principal: value.ada,
    source: 'scim',
    externalGroupIds: [],
    evidence: value.authority,
  });
  assert.equal(second.managedMemberships[0].state, 'suspended');
  const persistedManual = value.state.organizations.memberships.find(
    (candidate) => candidate.id === manual.id,
  );
  assert.equal(persistedManual.state, 'active');
});

test('Provisioning rejects unverified adapters and cannot map organization owner', async () => {
  const value = fixture();
  const { organization } = await enterprise(value);
  await verifyAcmeDomain(value, organization.id);
  const provider = await value.organizations.configureIdentityProvider({
    actor: value.owner,
    organizationId: organization.id,
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    displayName: 'Acme SSO',
    verifiedDomains: ['acme.example'],
    jit: { enabled: true, defaultRoles: ['member'] },
    scimEnabled: true,
    requireMfa: false,
  });
  await assert.rejects(
    value.organizations.saveIdentityProviderGroupMapping({
      actor: value.owner,
      organizationId: organization.id,
      identityProviderId: provider.id,
      externalGroupId: 'break-glass',
      scope: { kind: 'organization', organizationId: organization.id },
      roles: ['owner'],
    }),
    /owner role cannot be externally managed/,
  );
  await assert.rejects(
    value.organizations.reconcileProvisionedMemberships({
      organizationId: organization.id,
      identityProviderId: provider.id,
      principal: value.ada,
      source: 'scim',
      externalGroupIds: [],
      evidence: { verifiedBy: 'caller-controlled' },
    }),
    /Provisioning authority was not verified/,
  );
});

test('SCIM deprovisioning invalidates an already resolved context without removing manual access', async () => {
  const value = fixture();
  const { organization, team } = await enterprise(value);
  await verifyAcmeDomain(value, organization.id);
  const provider = await value.organizations.configureIdentityProvider({
    actor: value.owner,
    organizationId: organization.id,
    protocol: 'oidc',
    issuer: 'https://login.acme.example',
    displayName: 'Acme SSO',
    verifiedDomains: ['acme.example'],
    jit: { enabled: true, defaultRoles: ['member'] },
    scimEnabled: true,
    requireMfa: false,
  });
  await value.organizations.saveIdentityProviderGroupMapping({
    actor: value.owner,
    organizationId: organization.id,
    identityProviderId: provider.id,
    externalGroupId: 'platform-engineers',
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });
  await value.organizations.reconcileProvisionedMemberships({
    organizationId: organization.id,
    identityProviderId: provider.id,
    principal: value.ada,
    source: 'scim',
    externalGroupIds: ['platform-engineers'],
    evidence: value.authority,
  });
  const context = await value.organizations.resolveContext(value.ada, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });

  await value.organizations.deprovisionProvisionedPrincipal({
    organizationId: organization.id,
    identityProviderId: provider.id,
    principal: value.ada,
    evidence: value.authority,
  });
  assert.deepEqual(
    await value.organizations.authorize(context, 'project.read', {
      organizationId: organization.id,
      teamId: team.id,
      projectId: 'prj_payments',
    }),
    { effect: 'deny', reason: 'stale-context' },
  );
});
