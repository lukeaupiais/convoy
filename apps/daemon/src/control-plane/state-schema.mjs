export function initialControlPlaneState(defaultWorkflow) {
  return {
    version: 2,
    sessions: {},
    runners: [],
    instructions: [],
    workflows: [structuredClone(defaultWorkflow)],
  };
}

/**
 * Apply coordinator-owned, additive migrations. Module-owned state migrations
 * remain with the module that knows their invariants.
 */
export function migrateControlPlaneState(state, { deploymentId = 'convoy-local' } = {}) {
  if (state.deploymentId && state.deploymentId !== deploymentId)
    throw new Error('Deployment identity changed. Explicit state migration is required.');
  state.deploymentId = deploymentId;
  const createdAt = state.createdAt ?? new Date().toISOString();
  state.createdAt ??= createdAt;
  state.identity ??= {
    users: [
      {
        id: 'local',
        displayName: 'Local operator',
        state: 'active',
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    deviceSessions: [],
    workloadIdentities: [],
    servicePrincipals: [],
    externalIdentityLinks: [],
  };
  state.identity.users ??= [];
  state.identity.deviceSessions ??= [];
  state.identity.workloadIdentities ??= [];
  state.identity.servicePrincipals ??= [];
  state.identity.externalIdentityLinks ??= [];
  if (!state.identity.users.some((user) => user.id === 'local'))
    state.identity.users.push({
      id: 'local',
      displayName: 'Local operator',
      state: 'active',
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    });
  state.organizations ??= {
    organizations: [
      {
        id: 'personal',
        slug: 'personal',
        displayName: 'Personal',
        kind: 'personal',
        state: 'active',
        policyRevision: '1',
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    teams: [],
    memberships: [
      {
        id: 'membership-local-personal',
        organizationId: 'personal',
        principal: { kind: 'user', userId: 'local' },
        scope: { kind: 'organization', organizationId: 'personal' },
        roles: ['owner'],
        state: 'active',
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    invitations: [],
    identityProviders: [],
    identityProviderGroupMappings: [],
    domainVerifications: [],
  };
  state.organizations.organizations ??= [];
  state.organizations.teams ??= [];
  state.organizations.memberships ??= [];
  state.organizations.invitations ??= [];
  state.organizations.identityProviders ??= [];
  state.organizations.identityProviderGroupMappings ??= [];
  state.organizations.domainVerifications ??= [];
  state.organizations.policies ??= [];
  for (const project of state.projects ?? []) project.organizationId ??= 'personal';
  const personalProjectId = state.projects?.find(
    (project) => project.organizationId === 'personal',
  )?.id;
  for (const rule of state.approvalRules ?? []) {
    rule.organizationId ??= 'personal';
    rule.projectId ??= rule.scope?.kind === 'project' ? rule.scope.value : personalProjectId;
  }
  for (const environment of state.environments ?? []) environment.organizationId ??= 'personal';
  for (const runner of state.runners ?? []) runner.organizationId ??= 'personal';
  for (const pool of state.runnerPools ?? []) pool.organizationId ??= 'personal';
  state.providerConnections ??= [];
  state.providerProbeEvidence ??= [];
  state.modelOfferings ??= [];
  state.modelRoutes ??= [];
  state.providerGrants ??= [];
  state.providerOutcomes ??= [];
  state.environmentAccessBindings ??= [];
  state.runnerEnrollments ??= [];
  state.channelGrants ??= [];
  state.capacityRequests ??= [];
  state.securityAuditRecords ??= [];
  state.version = 2;
  return state;
}
