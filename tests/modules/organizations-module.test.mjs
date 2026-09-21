import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizations } from '../../apps/daemon/src/modules/organizations/index.mjs';

function fixture() {
  let nextId = 0;
  let currentTime = Date.parse('2026-09-20T12:00:00.000Z');
  const state = {};
  const users = new Map([
    ['usr_owner', 'owner@acme.example'],
    ['usr_member', 'member@acme.example'],
    ['usr_wrong', 'wrong@example.net'],
  ]);
  const projects = [
    {
      id: 'prj_payments',
      organizationId: 'org_1',
      teamId: 'team_3',
      slug: 'payments',
      displayName: 'Payments',
    },
  ];
  const organizations = createOrganizations({
    state,
    deploymentId: 'dep_local',
    save: async () => {},
    generateId: (prefix) => `${prefix}_${++nextId}`,
    now: () => new Date(currentTime),
    assertPrincipalActive: async (principal) => {
      if (
        !(
          (principal?.kind === 'user' && users.has(principal.userId)) ||
          (principal?.kind === 'service-principal' &&
            principal.servicePrincipalId === 'svc_release') ||
          (principal?.kind === 'workload' && principal.workloadIdentityId === 'wli_release')
        )
      ) {
        throw new Error('Principal is not active.');
      }
      return principal;
    },
    getPrincipalEmail: async (principal) => users.get(principal.userId),
    projects: {
      listByOrganization: async (organizationId) =>
        projects.filter((project) => project.organizationId === organizationId),
      get: async (organizationId, projectId) =>
        projects.find(
          (project) => project.organizationId === organizationId && project.id === projectId,
        ),
    },
  });
  return {
    organizations,
    state,
    owner: { kind: 'user', userId: 'usr_owner' },
    member: { kind: 'user', userId: 'usr_member' },
    wrong: { kind: 'user', userId: 'usr_wrong' },
    advance(milliseconds) {
      currentTime += milliseconds;
    },
  };
}

test('Organizations restrict machine principals to bounded non-administrative roles', async () => {
  const value = fixture();
  const { organizations, owner } = value;
  const { organization } = await bootstrap(value);
  const servicePrincipal = {
    kind: 'service-principal',
    servicePrincipalId: 'svc_release',
  };
  const workload = { kind: 'workload', workloadIdentityId: 'wli_release' };

  for (const principal of [servicePrincipal, workload]) {
    for (const role of ['owner', 'admin', 'security-admin', 'billing-admin']) {
      await assert.rejects(
        organizations.createMembership({
          actor: owner,
          organizationId: organization.id,
          principal,
          scope: { kind: 'organization', organizationId: organization.id },
          roles: [role],
        }),
        /Machine principals require bounded roles/,
      );
    }
  }

  const organizationMembership = await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: servicePrincipal,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  const projectMembership = await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: servicePrincipal,
    scope: { kind: 'project', projectId: 'prj_payments' },
    roles: ['contributor'],
  });
  assert.deepEqual(organizationMembership.roles, ['member']);
  assert.deepEqual(projectMembership.roles, ['contributor']);
  await assert.rejects(
    organizations.updateMembership({
      actor: owner,
      organizationId: organization.id,
      membershipId: organizationMembership.id,
      roles: ['admin'],
    }),
    /Machine principals require bounded roles/,
  );
});

async function bootstrap(fixtureValue) {
  const { organizations, owner } = fixtureValue;
  const organization = await organizations.createOrganization({
    slug: 'acme',
    displayName: 'Acme Corp',
    kind: 'enterprise',
    owner,
  });
  const team = await organizations.createTeam({
    actor: owner,
    organizationId: organization.id,
    slug: 'platform',
    displayName: 'Platform',
  });
  return { organization, team };
}

test('Organizations isolate tenants and resolve role permissions only within the membership scope', async () => {
  const value = fixture();
  const { organizations, owner, member } = value;
  const { organization, team } = await bootstrap(value);
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });

  const contexts = await organizations.listAvailableContexts(member);
  assert.deepEqual(
    contexts.map((context) => context.label),
    ['Acme Corp / Platform / Payments'],
  );
  const context = await organizations.resolveContext(member, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });
  assert.equal(
    (
      await organizations.authorize(context, 'project.execute', {
        organizationId: organization.id,
        teamId: team.id,
        projectId: 'prj_payments',
      })
    ).effect,
    'allow',
  );
  assert.equal(
    (
      await organizations.authorize(context, 'organization.manage', {
        organizationId: organization.id,
      })
    ).effect,
    'deny',
  );
  assert.equal(
    (
      await organizations.authorize(context, 'project.read', {
        organizationId: 'org_other',
        projectId: 'prj_payments',
      })
    ).effect,
    'deny',
  );
});

test('Organizations invalidate cached contexts after membership or policy revisions change', async () => {
  const value = fixture();
  const { organizations, owner, member } = value;
  const { organization, team } = await bootstrap(value);
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  const teamMembership = await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });
  const context = await organizations.resolveContext(member, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });

  await organizations.updateMembership({
    actor: owner,
    organizationId: organization.id,
    membershipId: teamMembership.id,
    roles: ['viewer'],
  });
  assert.deepEqual(
    await organizations.authorize(context, 'project.execute', {
      organizationId: organization.id,
      teamId: team.id,
      projectId: 'prj_payments',
    }),
    { effect: 'deny', reason: 'stale-context' },
  );

  const refreshed = await organizations.resolveContext(member, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });
  await organizations.setPolicyRevision({
    actor: owner,
    organizationId: organization.id,
    policyRevision: 'policy-2',
  });
  assert.equal(
    (
      await organizations.authorize(refreshed, 'project.read', {
        organizationId: organization.id,
        projectId: 'prj_payments',
      })
    ).reason,
    'stale-context',
  );
});

test('organization policy is a parent ceiling with deny precedence and revision invalidation', async () => {
  const value = fixture();
  const { organizations, owner, member } = value;
  const { organization, team } = await bootstrap(value);
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });
  const context = await organizations.resolveContext(member, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });

  const parent = await organizations.savePolicy({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    rules: {
      permissions: { 'project.execute': 'deny' },
      personalProviders: 'deny',
      fullSystemAccess: 'ask',
    },
    expectedRevision: 0,
  });
  assert.equal(parent.revision, 1);
  await organizations.savePolicy({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'team', teamId: team.id },
    rules: {
      permissions: { 'project.execute': 'allow' },
      personalProviders: 'allow',
      fullSystemAccess: 'allow',
    },
    expectedRevision: 0,
  });

  const effective = await organizations.evaluatePolicy({
    context: {
      ...context,
      policyRevision: value.state.organizations.organizations[0].policyRevision,
    },
    action: 'project.execute',
    resource: {
      organizationId: organization.id,
      teamId: team.id,
      projectId: 'prj_payments',
    },
    personalProvider: true,
    fullSystemAccess: true,
    approved: true,
  });
  assert.deepEqual(effective, {
    effect: 'deny',
    reason: 'organization-policy',
    policyRevision: value.state.organizations.organizations[0].policyRevision,
  });
  assert.equal(
    (
      await organizations.authorize(
        { ...context, policyRevision: value.state.organizations.organizations[0].policyRevision },
        'project.execute',
        {
          organizationId: organization.id,
          teamId: team.id,
          projectId: 'prj_payments',
        },
      )
    ).effect,
    'deny',
  );
  assert.equal(
    (
      await organizations.authorize(context, 'project.read', {
        organizationId: organization.id,
        teamId: team.id,
        projectId: 'prj_payments',
      })
    ).reason,
    'stale-context',
  );
});

test('policy ask can be satisfied by approval but denial cannot', async () => {
  const value = fixture();
  const { organizations, owner } = value;
  const { organization, team } = await bootstrap(value);
  await organizations.savePolicy({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'project', projectId: 'prj_payments' },
    rules: { permissions: { 'project.execute': 'ask' } },
    expectedRevision: 0,
  });
  const base = {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  };
  assert.equal(
    (await organizations.evaluatePolicy({ action: 'project.execute', resource: base })).effect,
    'ask',
  );
  assert.equal(
    (
      await organizations.evaluatePolicy({
        action: 'project.execute',
        resource: base,
        approved: true,
      })
    ).effect,
    'allow',
  );
  await assert.rejects(
    organizations.savePolicy({
      actor: owner,
      organizationId: organization.id,
      scope: { kind: 'project', projectId: 'prj_payments' },
      rules: {},
      expectedRevision: 0,
    }),
    /Policy changed/,
  );
});

test('Organization invitations are identity-bound, expiring, and single-use', async () => {
  const value = fixture();
  const { organizations, owner, member, wrong, advance } = value;
  const { organization } = await bootstrap(value);
  const invitation = await organizations.createInvitation({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['viewer'],
    email: 'member@acme.example',
    ttlMs: 10_000,
  });

  assert.equal(value.state.organizations.invitations[0].token, undefined);
  await assert.rejects(
    organizations.acceptInvitation({ token: invitation.token, principal: wrong }),
    /Invitation is not available/,
  );
  const membership = await organizations.acceptInvitation({
    token: invitation.token,
    principal: member,
  });
  assert.deepEqual(membership.roles, ['viewer']);
  await assert.rejects(
    organizations.acceptInvitation({ token: invitation.token, principal: member }),
    /Invitation is not available/,
  );

  const expiring = await organizations.createInvitation({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['viewer'],
    email: 'wrong@example.net',
    ttlMs: 1,
  });
  advance(2);
  await assert.rejects(
    organizations.acceptInvitation({ token: expiring.token, principal: wrong }),
    /Invitation is not available/,
  );
});

test('Organizations preserve at least one active organization owner', async () => {
  const value = fixture();
  const { organizations, owner } = value;
  const { organization } = await bootstrap(value);
  const ownerMembership = value.state.organizations.memberships.find((membership) =>
    membership.roles.includes('owner'),
  );

  await assert.rejects(
    organizations.updateMembership({
      actor: owner,
      organizationId: organization.id,
      membershipId: ownerMembership.id,
      state: 'revoked',
    }),
    /last active organization owner/,
  );
});

test('Archiving a team invalidates its contexts and revoked invitations cannot be accepted', async () => {
  const value = fixture();
  const { organizations, owner, member } = value;
  const { organization, team } = await bootstrap(value);
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['member'],
  });
  await organizations.createMembership({
    actor: owner,
    organizationId: organization.id,
    principal: member,
    scope: { kind: 'team', teamId: team.id },
    roles: ['member'],
  });
  const context = await organizations.resolveContext(member, {
    organizationId: organization.id,
    teamId: team.id,
    projectId: 'prj_payments',
  });
  await organizations.updateTeam({
    actor: owner,
    organizationId: organization.id,
    teamId: team.id,
    state: 'archived',
  });
  assert.equal(
    (
      await organizations.authorize(context, 'project.read', {
        organizationId: organization.id,
        teamId: team.id,
        projectId: 'prj_payments',
      })
    ).effect,
    'deny',
  );

  const invitation = await organizations.createInvitation({
    actor: owner,
    organizationId: organization.id,
    scope: { kind: 'organization', organizationId: organization.id },
    roles: ['viewer'],
    email: 'wrong@example.net',
    ttlMs: 10_000,
  });
  await organizations.revokeInvitation({
    actor: owner,
    organizationId: organization.id,
    invitationId: invitation.invitation.id,
  });
  await assert.rejects(
    organizations.acceptInvitation({ token: invitation.token, principal: value.wrong }),
    /Invitation is not available/,
  );
});
