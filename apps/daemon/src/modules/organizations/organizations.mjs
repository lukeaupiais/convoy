import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ORGANIZATION_KINDS = new Set(['personal', 'team', 'enterprise']);
const ORGANIZATION_STATES = new Set(['active', 'suspended']);
const TEAM_STATES = new Set(['active', 'archived']);
const MEMBERSHIP_STATES = new Set(['invited', 'active', 'suspended', 'revoked']);
const MACHINE_PRINCIPAL_ROLES = Object.freeze({
  organization: new Set(['member']),
  team: new Set(),
  project: new Set(['contributor', 'maintainer']),
});

export const ORGANIZATION_ROLE_PERMISSIONS = Object.freeze({
  organization: Object.freeze({
    owner: Object.freeze(['*']),
    admin: Object.freeze([
      'organization.read',
      'organization.manage',
      'team.manage',
      'membership.manage',
      'invitation.manage',
      'context.list',
      'project.read',
      'project.write',
      'project.execute',
      'project.manage',
      'provider.manage',
      'provider.use',
      'environment.manage',
      'environment.use',
    ]),
    'security-admin': Object.freeze([
      'organization.read',
      'membership.read',
      'membership.manage',
      'invitation.manage',
      'security.manage',
      'audit.read',
      'context.list',
      'provider.read',
      'environment.read',
    ]),
    'billing-admin': Object.freeze([
      'organization.read',
      'billing.read',
      'billing.manage',
      'context.list',
      'provider.read',
    ]),
    member: Object.freeze(['organization.read', 'context.list', 'provider.use', 'environment.use']),
    viewer: Object.freeze(['organization.read', 'context.list']),
  }),
  team: Object.freeze({
    admin: Object.freeze([
      'team.read',
      'team.manage',
      'team.membership.manage',
      'context.use',
      'project.read',
      'project.write',
      'project.execute',
    ]),
    member: Object.freeze(['team.read', 'context.use', 'project.read', 'project.execute']),
    viewer: Object.freeze(['team.read', 'context.use', 'project.read']),
  }),
  project: Object.freeze({
    owner: Object.freeze([
      'context.use',
      'project.read',
      'project.write',
      'project.execute',
      'project.manage',
    ]),
    maintainer: Object.freeze([
      'context.use',
      'project.read',
      'project.write',
      'project.execute',
      'project.manage',
    ]),
    contributor: Object.freeze(['context.use', 'project.read', 'project.write', 'project.execute']),
    viewer: Object.freeze(['context.use', 'project.read']),
  }),
});

export function createOrganizations({
  state,
  deploymentId,
  save = async () => {},
  generateId = (prefix) => `${prefix}_${randomUUID()}`,
  now = () => new Date(),
  assertPrincipalActive = async (principal) => principal,
  getPrincipalEmail = async () => undefined,
  authorizeProvisioning = async () => false,
  verifyDomainControl = async () => undefined,
  projects = { listByOrganization: async () => [], get: async () => undefined },
} = {}) {
  if (!state || typeof state !== 'object')
    throw new TypeError('Organizations requires mutable state.');
  requiredText(deploymentId, 'deploymentId');
  if (typeof projects.listByOrganization !== 'function' || typeof projects.get !== 'function') {
    throw new TypeError('Organizations requires project list and lookup functions.');
  }
  const records = (state.organizations ??= {
    organizations: [],
    teams: [],
    memberships: [],
    invitations: [],
  });
  records.organizations ??= [];
  records.teams ??= [];
  records.memberships ??= [];
  records.invitations ??= [];
  records.identityProviders ??= [];
  records.identityProviderGroupMappings ??= [];
  records.domainVerifications ??= [];
  records.policies ??= [];

  async function createOrganization(input) {
    const owner = await activePrincipal(input?.owner);
    const slug = validSlug(input?.slug);
    if (records.organizations.some((candidate) => candidate.slug === slug)) {
      throw new Error('Organization slug is already in use.');
    }
    if (!ORGANIZATION_KINDS.has(input?.kind)) throw new Error('Unsupported organization kind.');
    const at = timestamp(now);
    const organization = {
      id: generateId('org'),
      slug,
      displayName: requiredText(input?.displayName, 'displayName'),
      kind: input.kind,
      state: 'active',
      policyRevision: '1',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.organizations.push(organization);
    records.memberships.push(
      membershipRecord({
        id: generateId('mem'),
        organizationId: organization.id,
        principal: owner,
        scope: { kind: 'organization', organizationId: organization.id },
        roles: ['owner'],
        at,
      }),
    );
    await save();
    return copy(organization);
  }

  async function createTeam(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'team.manage');
    const organization = activeOrganization(input.organizationId);
    const slug = validSlug(input?.slug);
    if (
      records.teams.some(
        (candidate) => candidate.organizationId === organization.id && candidate.slug === slug,
      )
    ) {
      throw new Error('Team slug is already in use.');
    }
    const at = timestamp(now);
    const team = {
      id: generateId('team'),
      organizationId: organization.id,
      slug,
      displayName: requiredText(input?.displayName, 'displayName'),
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.teams.push(team);
    await save();
    return copy(team);
  }

  async function updateTeam(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'team.manage');
    activeOrganization(input.organizationId);
    const team = records.teams.find(
      (candidate) =>
        candidate.id === input?.teamId && candidate.organizationId === input.organizationId,
    );
    if (!team) throw new Error('Team not found.');
    const nextState = input.state ?? team.state;
    if (!TEAM_STATES.has(nextState)) throw new Error('Unsupported team state.');
    const displayName =
      input.displayName === undefined
        ? team.displayName
        : requiredText(input.displayName, 'displayName');
    if (team.state !== nextState || team.displayName !== displayName) {
      team.state = nextState;
      team.displayName = displayName;
      team.revision += 1;
      team.updatedAt = timestamp(now);
      await save();
    }
    return copy(team);
  }

  async function createMembership(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'membership.manage');
    const organization = activeOrganization(input.organizationId);
    const principal = await activePrincipal(input?.principal, organization.id);
    const scope = await validateScope(organization.id, input?.scope);
    const roles = validatePrincipalRoles(principal, scope.kind, input?.roles);
    if (findMembership(organization.id, principal, scope, false)) {
      throw new Error('An active membership already exists for that scope.');
    }
    const membership = membershipRecord({
      id: generateId('mem'),
      organizationId: organization.id,
      principal,
      scope,
      roles,
      at: timestamp(now),
    });
    records.memberships.push(membership);
    await save();
    return copy(membership);
  }

  async function updateMembership(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'membership.manage');
    activeOrganization(input.organizationId);
    const membership = tenantMembership(input.organizationId, input?.membershipId);
    const nextRoles =
      input.roles === undefined
        ? membership.roles
        : validatePrincipalRoles(membership.principal, membership.scope.kind, input.roles);
    const nextState = input.state ?? membership.state;
    if (!MEMBERSHIP_STATES.has(nextState) || nextState === 'invited') {
      throw new Error('Unsupported membership state.');
    }
    if (membership.state === 'revoked' && nextState !== 'revoked') {
      throw new Error('Revoked memberships cannot be reactivated.');
    }
    const removesOwner =
      membership.scope.kind === 'organization' &&
      membership.roles.includes('owner') &&
      (nextState !== 'active' || !nextRoles.includes('owner'));
    if (removesOwner && activeOwnerCount(input.organizationId) === 1) {
      throw new Error('Cannot remove the last active organization owner.');
    }
    if (!sameStrings(membership.roles, nextRoles) || membership.state !== nextState) {
      membership.roles = [...nextRoles];
      membership.state = nextState;
      membership.revision += 1;
      membership.updatedAt = timestamp(now);
      await save();
    }
    return copy(membership);
  }

  async function setOrganizationState(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'organization.manage');
    if (!ORGANIZATION_STATES.has(input?.state)) throw new Error('Unsupported organization state.');
    const organization = tenantOrganization(input.organizationId);
    if (organization.state !== input.state) {
      organization.state = input.state;
      organization.revision += 1;
      organization.updatedAt = timestamp(now);
      await save();
    }
    return copy(organization);
  }

  async function setPolicyRevision(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'organization.manage');
    const organization = activeOrganization(input.organizationId);
    const policyRevision = requiredText(input?.policyRevision, 'policyRevision');
    if (organization.policyRevision !== policyRevision) {
      organization.policyRevision = policyRevision;
      organization.revision += 1;
      organization.updatedAt = timestamp(now);
      await save();
    }
    return copy(organization);
  }

  async function savePolicy(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'organization.manage');
    const organization = activeOrganization(input.organizationId);
    const scope = await validateScope(organization.id, input?.scope);
    const rules = validatePolicyRules(input?.rules);
    const existing = records.policies.find(
      (candidate) =>
        candidate.organizationId === organization.id && sameScope(candidate.scope, scope),
    );
    const expectedRevision = input?.baseRevision ?? input?.expectedRevision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer.');
    }
    if ((existing?.revision ?? 0) !== expectedRevision) {
      throw new Error('Policy changed in another client. Reload before saving.');
    }
    const at = timestamp(now);
    const policy = existing ?? {
      id: generateId('pol'),
      organizationId: organization.id,
      scope,
      revision: 0,
      createdAt: at,
    };
    policy.rules = rules;
    policy.revision += 1;
    policy.updatedAt = at;
    if (!existing) records.policies.push(policy);
    organization.policyRevision = String(Number(organization.policyRevision || 0) + 1);
    organization.revision += 1;
    organization.updatedAt = at;
    await save();
    return copy(policy);
  }

  async function evaluatePolicy(input) {
    const resource = input?.resource;
    const organization = activeOrganization(resource?.organizationId);
    const project = resource?.projectId
      ? await projects.get(organization.id, resource.projectId)
      : undefined;
    if (resource?.projectId && !project) return denied();
    if (resource?.teamId && !activeTeam(organization.id, resource.teamId, false)) return denied();
    if (project && (project.teamId ?? undefined) !== (resource.teamId ?? undefined))
      return denied();
    if (input?.context && input.context.policyRevision !== organization.policyRevision) {
      return { effect: 'deny', reason: 'stale-context' };
    }
    const policies = applicablePolicies(organization.id, resource);
    const decisions = [];
    for (const policy of policies) {
      const permission = policy.rules.permissions?.[input?.action];
      if (permission) decisions.push({ effect: permission, scope: policy.scope.kind });
      if (input?.personalProvider && policy.rules.personalProviders) {
        decisions.push({ effect: policy.rules.personalProviders, scope: policy.scope.kind });
      }
      if (input?.fullSystemAccess && policy.rules.fullSystemAccess) {
        decisions.push({ effect: policy.rules.fullSystemAccess, scope: policy.scope.kind });
      }
    }
    const controlling =
      decisions.find((decision) => decision.effect === 'deny') ??
      decisions.find((decision) => decision.effect === 'ask');
    const effect =
      controlling?.effect === 'ask' && input?.approved === true
        ? 'allow'
        : (controlling?.effect ?? 'allow');
    return {
      effect,
      reason: controlling ? `${controlling.scope}-policy` : 'policy-default',
      policyRevision: organization.policyRevision,
    };
  }

  async function createInvitation(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'invitation.manage');
    const organization = activeOrganization(input.organizationId);
    const scope = await validateScope(organization.id, input?.scope);
    const roles = validateRoles(scope.kind, input?.roles);
    const ttlMs = positiveDuration(input?.ttlMs);
    const email = input.email === undefined ? undefined : validEmail(input.email);
    const domain = input.domain === undefined ? undefined : validDomain(input.domain);
    if (!email && !domain) throw new Error('Invitation must be bound to an email or domain.');
    const token = `inv_${randomBytes(32).toString('base64url')}`;
    const created = nowDate(now);
    const invitation = {
      id: generateId('inv'),
      organizationId: organization.id,
      scope,
      roles,
      ...(email ? { email } : {}),
      ...(domain ? { domain } : {}),
      tokenHash: digest(token),
      state: 'pending',
      revision: 1,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
    };
    records.invitations.push(invitation);
    await save();
    return { invitation: publicInvitation(invitation), token };
  }

  async function acceptInvitation(input) {
    let principal = await activePrincipal(input?.principal);
    if (principal.kind !== 'user') throw unavailableInvitation();
    const invitation = records.invitations.find(
      (candidate) => candidate.tokenHash === digest(requiredText(input?.token, 'token')),
    );
    if (!invitation || invitation.state !== 'pending') throw unavailableInvitation();
    const organization = records.organizations.find(
      (candidate) => candidate.id === invitation.organizationId && candidate.state === 'active',
    );
    if (!organization || Date.parse(invitation.expiresAt) <= nowDate(now).getTime()) {
      if (invitation && invitation.state === 'pending') {
        invitation.state = 'expired';
        invitation.revision += 1;
        invitation.updatedAt = timestamp(now);
        await save();
      }
      throw unavailableInvitation();
    }
    principal = await activePrincipal(principal, organization.id);
    const email = (await getPrincipalEmail(principal))?.toLowerCase();
    if (
      !email ||
      (invitation.email && email !== invitation.email) ||
      (invitation.domain && email.split('@')[1] !== invitation.domain)
    ) {
      throw unavailableInvitation();
    }
    if (findMembership(organization.id, principal, invitation.scope, false)) {
      throw unavailableInvitation();
    }

    const at = timestamp(now);
    if (invitation.scope.kind !== 'organization') {
      const organizationScope = { kind: 'organization', organizationId: organization.id };
      if (!findMembership(organization.id, principal, organizationScope, false)) {
        records.memberships.push(
          membershipRecord({
            id: generateId('mem'),
            organizationId: organization.id,
            principal,
            scope: organizationScope,
            roles: ['member'],
            at,
          }),
        );
      }
    }
    const membership = membershipRecord({
      id: generateId('mem'),
      organizationId: organization.id,
      principal,
      scope: invitation.scope,
      roles: invitation.roles,
      at,
    });
    records.memberships.push(membership);
    invitation.state = 'accepted';
    invitation.revision += 1;
    invitation.acceptedBy = copy(principal);
    invitation.acceptedAt = at;
    await save();
    return copy(membership);
  }

  async function revokeInvitation(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'invitation.manage');
    activeOrganization(input.organizationId);
    const invitation = records.invitations.find(
      (candidate) =>
        candidate.id === input?.invitationId &&
        candidate.organizationId === input.organizationId &&
        candidate.state === 'pending',
    );
    if (!invitation) throw unavailableInvitation();
    invitation.state = 'revoked';
    invitation.revision += 1;
    invitation.revokedAt = timestamp(now);
    await save();
    return publicInvitation(invitation);
  }

  async function configureIdentityProvider(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'security.manage');
    const organization = activeOrganization(input.organizationId);
    if (organization.kind !== 'enterprise') {
      throw new Error('Enterprise identity providers require an enterprise organization.');
    }
    const protocol = input?.protocol;
    if (protocol !== 'oidc' && protocol !== 'saml') {
      throw new Error('Unsupported identity provider protocol.');
    }
    const issuer = validIssuer(input?.issuer);
    if (
      records.identityProviders.some(
        (candidate) =>
          candidate.organizationId === organization.id &&
          candidate.issuer === issuer &&
          candidate.state === 'active',
      )
    ) {
      throw new Error('Identity provider issuer is already configured.');
    }
    const verifiedDomains = [...new Set((input?.verifiedDomains ?? []).map(validDomain))].sort();
    if (verifiedDomains.length === 0) {
      throw new Error('At least one verified organization domain is required.');
    }
    if (
      verifiedDomains.some(
        (domain) =>
          !records.domainVerifications.some(
            (candidate) =>
              candidate.organizationId === organization.id &&
              candidate.domain === domain &&
              candidate.state === 'verified',
          ),
      )
    ) {
      throw new Error('Domain control has not been verified.');
    }
    const jitEnabled = input?.jit?.enabled === true;
    const defaultRoles = validateRoles('organization', input?.jit?.defaultRoles ?? ['member']);
    if (defaultRoles.includes('owner')) {
      throw new Error('The organization owner role cannot be externally managed.');
    }
    const at = timestamp(now);
    const provider = {
      id: generateId('idp'),
      organizationId: organization.id,
      protocol,
      issuer,
      displayName: requiredText(input?.displayName, 'displayName'),
      verifiedDomains,
      jit: { enabled: jitEnabled, defaultRoles },
      scimEnabled: input?.scimEnabled === true,
      ...(input?.requiredAuthenticationStrength
        ? {
            requiredAuthenticationStrength: requiredText(
              input.requiredAuthenticationStrength,
              'requiredAuthenticationStrength',
            ),
          }
        : {}),
      requireMfa: input?.requireMfa === true,
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.identityProviders.push(provider);
    await save();
    return copy(provider);
  }

  async function beginDomainVerification(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'security.manage');
    const organization = activeOrganization(input.organizationId);
    if (organization.kind !== 'enterprise') {
      throw new Error('Domain verification requires an enterprise organization.');
    }
    const domain = validDomain(input?.domain);
    if (
      records.domainVerifications.some(
        (candidate) =>
          candidate.organizationId === organization.id &&
          candidate.domain === domain &&
          candidate.state === 'verified',
      )
    ) {
      throw new Error('Domain control is already verified.');
    }
    const challenge = `convoy-domain-verification=${randomBytes(24).toString('base64url')}`;
    const created = nowDate(now);
    const ttlMs = input?.ttlMs === undefined ? 600_000 : positiveDuration(input.ttlMs);
    const verification = {
      id: generateId('dmv'),
      organizationId: organization.id,
      domain,
      challengeHash: digest(challenge),
      state: 'pending',
      revision: 1,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
    };
    records.domainVerifications.push(verification);
    await save();
    return { verification: publicDomainVerification(verification), challenge };
  }

  async function completeDomainVerification(input) {
    const organizationId = requiredText(input?.organizationId, 'organizationId');
    activeOrganization(organizationId);
    const verification = records.domainVerifications.find(
      (candidate) =>
        candidate.id === input?.domainVerificationId && candidate.organizationId === organizationId,
    );
    if (!verification || verification.state !== 'pending') {
      throw new Error('Domain verification is not pending.');
    }
    if (Date.parse(verification.expiresAt) <= nowDate(now).getTime()) {
      verification.state = 'expired';
      verification.revision += 1;
      verification.updatedAt = timestamp(now);
      await save();
      throw new Error('Domain verification has expired.');
    }
    const result = await verifyDomainControl({
      organizationId,
      domain: verification.domain,
      evidence: input?.evidence,
    });
    const observedChallenge = typeof result === 'string' ? result : result?.observedChallenge;
    if (
      typeof observedChallenge !== 'string' ||
      digest(observedChallenge) !== verification.challengeHash
    ) {
      throw new Error('Domain control was not verified.');
    }
    verification.state = 'verified';
    verification.revision += 1;
    verification.verifiedAt = timestamp(now);
    verification.updatedAt = verification.verifiedAt;
    if (typeof result?.evidenceRef === 'string') {
      verification.evidenceRef = requiredText(result.evidenceRef, 'evidenceRef');
    }
    await save();
    return publicDomainVerification(verification);
  }

  async function saveIdentityProviderGroupMapping(input) {
    await requireOrganizationPermission(input?.actor, input?.organizationId, 'security.manage');
    const provider = activeIdentityProvider(input.organizationId, input?.identityProviderId);
    const scope = await validateScope(provider.organizationId, input?.scope);
    const roles = validateRoles(scope.kind, input?.roles);
    if (roles.includes('owner')) {
      throw new Error('The organization owner role cannot be externally managed.');
    }
    const externalGroupId = requiredText(input?.externalGroupId, 'externalGroupId');
    const existing = records.identityProviderGroupMappings.find(
      (candidate) =>
        candidate.organizationId === provider.organizationId &&
        candidate.identityProviderId === provider.id &&
        candidate.externalGroupId === externalGroupId &&
        sameScope(candidate.scope, scope),
    );
    if (existing) {
      if (!sameStrings(existing.roles, roles) || existing.state !== 'active') {
        existing.roles = roles;
        existing.state = 'active';
        existing.revision += 1;
        existing.updatedAt = timestamp(now);
        await save();
      }
      return copy(existing);
    }
    const at = timestamp(now);
    const mapping = {
      id: generateId('igm'),
      organizationId: provider.organizationId,
      identityProviderId: provider.id,
      externalGroupId,
      scope,
      roles,
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.identityProviderGroupMappings.push(mapping);
    await save();
    return copy(mapping);
  }

  async function evaluateFederatedAccess(input) {
    const provider = activeIdentityProvider(input?.organizationId, input?.identityProviderId);
    if (input?.emailVerified !== true) {
      throw new Error('Federated email must be verified.');
    }
    const email = validEmail(input?.email);
    if (!provider.verifiedDomains.includes(email.split('@')[1])) {
      throw new Error('Federated email is not in a verified organization domain.');
    }
    if (
      provider.requiredAuthenticationStrength &&
      input?.authenticationStrength !== provider.requiredAuthenticationStrength
    ) {
      throw new Error('Required authentication strength was not satisfied.');
    }
    if (provider.requireMfa && input?.mfa !== true) {
      throw new Error('Required authentication strength was not satisfied.');
    }
    if (!provider.jit.enabled) throw new Error('Just-in-time provisioning is not enabled.');
    return {
      organizationId: provider.organizationId,
      identityProviderId: provider.id,
      provisioning: 'jit',
      defaultRoles: [...provider.jit.defaultRoles],
    };
  }

  async function reconcileProvisionedMemberships(input) {
    const provider = activeIdentityProvider(input?.organizationId, input?.identityProviderId);
    const source = input?.source;
    if (source !== 'jit' && source !== 'scim') throw new Error('Unsupported provisioning source.');
    if (source === 'jit' && !provider.jit.enabled) {
      throw new Error('Just-in-time provisioning is not enabled.');
    }
    if (source === 'scim' && !provider.scimEnabled) {
      throw new Error('SCIM provisioning is not enabled.');
    }
    const authorized = await authorizeProvisioning({
      operation: 'reconcile-memberships',
      provider: copy(provider),
      principal: copy(input?.principal),
      source,
      evidence: input?.evidence,
    });
    if (authorized !== true) throw new Error('Provisioning authority was not verified.');
    const principal = await activePrincipal(input?.principal, provider.organizationId);
    const groupIds = new Set(
      (input?.externalGroupIds ?? []).map((value) => requiredText(value, 'externalGroupId')),
    );
    const desiredMappings = records.identityProviderGroupMappings.filter(
      (candidate) =>
        candidate.organizationId === provider.organizationId &&
        candidate.identityProviderId === provider.id &&
        candidate.state === 'active' &&
        groupIds.has(candidate.externalGroupId),
    );
    const desired = desiredMappings.map((mapping) => ({
      scope: mapping.scope,
      roles: mapping.roles,
      managedBy: {
        kind: 'identity-provider-group',
        identityProviderId: provider.id,
        externalGroupId: mapping.externalGroupId,
      },
    }));
    const organizationScope = {
      kind: 'organization',
      organizationId: provider.organizationId,
    };
    if (!findMembership(provider.organizationId, principal, organizationScope, false)) {
      desired.unshift({
        scope: organizationScope,
        roles: provider.jit.defaultRoles,
        managedBy: { kind: source, identityProviderId: provider.id },
      });
    }
    const at = timestamp(now);
    for (const item of desired) {
      const membership = findManagedMembership(
        provider.organizationId,
        provider.id,
        principal,
        item.scope,
      );
      if (membership) {
        if (membership.state !== 'active' || !sameStrings(membership.roles, item.roles)) {
          membership.state = 'active';
          membership.roles = [...item.roles];
          membership.managedBy = copy(item.managedBy);
          membership.revision += 1;
          membership.updatedAt = at;
        }
      } else if (!findMembership(provider.organizationId, principal, item.scope, false)) {
        records.memberships.push({
          ...membershipRecord({
            id: generateId('mem'),
            organizationId: provider.organizationId,
            principal,
            scope: item.scope,
            roles: item.roles,
            at,
          }),
          managedBy: copy(item.managedBy),
        });
      }
    }
    for (const membership of managedMemberships(provider.id, principal)) {
      const remainsDesired = desired.some((item) => sameScope(item.scope, membership.scope));
      if (!remainsDesired && membership.state === 'active') {
        membership.state = 'suspended';
        membership.revision += 1;
        membership.updatedAt = at;
      }
    }
    await save();
    return { managedMemberships: managedMemberships(provider.id, principal).map(copy) };
  }

  async function deprovisionProvisionedPrincipal(input) {
    const provider = activeIdentityProvider(input?.organizationId, input?.identityProviderId);
    if (!provider.scimEnabled) throw new Error('SCIM provisioning is not enabled.');
    const authorized = await authorizeProvisioning({
      operation: 'deprovision-principal',
      provider: copy(provider),
      principal: copy(input?.principal),
      source: 'scim',
      evidence: input?.evidence,
    });
    if (authorized !== true) throw new Error('Provisioning authority was not verified.');
    const principal = await activePrincipal(input?.principal, provider.organizationId);
    const memberships = managedMemberships(provider.id, principal);
    const at = timestamp(now);
    for (const membership of memberships) {
      if (membership.state === 'active') {
        membership.state = 'suspended';
        membership.revision += 1;
        membership.updatedAt = at;
      }
    }
    await save();
    return { managedMemberships: memberships.map(copy) };
  }

  async function listAvailableContexts(principalInput) {
    const principal = await activePrincipal(principalInput);
    const summaries = [];
    for (const organization of records.organizations) {
      if (organization.state !== 'active') continue;
      try {
        await activePrincipal(principal, organization.id);
      } catch {
        continue;
      }
      const organizationMembership = activeMembership(organization.id, principal, {
        kind: 'organization',
        organizationId: organization.id,
      });
      if (!organizationMembership) continue;
      const availableProjects = await projects.listByOrganization(organization.id);
      for (const project of availableProjects) {
        if (project.organizationId !== organization.id) continue;
        const team = project.teamId
          ? activeTeam(organization.id, project.teamId, false)
          : undefined;
        if (project.teamId && !team) continue;
        const memberships = applicableMemberships(organization.id, principal, project);
        if (!canUseProject(memberships)) continue;
        summaries.push({
          organizationId: organization.id,
          organizationSlug: organization.slug,
          organizationDisplayName: organization.displayName,
          ...(team
            ? { teamId: team.id, teamSlug: team.slug, teamDisplayName: team.displayName }
            : {}),
          projectId: project.id,
          projectSlug: project.slug,
          projectDisplayName: project.displayName,
          label: [organization.displayName, team?.displayName, project.displayName]
            .filter(Boolean)
            .join(' / '),
        });
      }
    }
    return summaries.sort((left, right) => left.label.localeCompare(right.label));
  }

  async function resolveContext(principalInput, requested) {
    let principal;
    try {
      const organization = activeOrganization(requested?.organizationId);
      principal = await activePrincipal(principalInput, organization.id);
      const project = await projects.get(organization.id, requested?.projectId);
      if (!project || project.organizationId !== organization.id) throw new Error();
      if ((project.teamId ?? undefined) !== (requested?.teamId ?? undefined)) throw new Error();
      if (project.teamId && !activeTeam(organization.id, project.teamId, false)) throw new Error();
      const organizationMembership = activeMembership(organization.id, principal, {
        kind: 'organization',
        organizationId: organization.id,
      });
      if (!organizationMembership) throw new Error();
      const memberships = applicableMemberships(organization.id, principal, project);
      if (!canUseProject(memberships)) throw new Error();
      const membershipRevision = revisionDigest(memberships);
      const base = {
        deploymentId,
        principal,
        ...(principal.kind === 'user' ? { userId: principal.userId } : {}),
        organizationId: organization.id,
        ...(project.teamId ? { teamId: project.teamId } : {}),
        projectId: project.id,
        membershipRevision,
        policyRevision: organization.policyRevision,
      };
      return { id: `ctx_${digest(JSON.stringify(base)).slice(0, 24)}`, ...copy(base) };
    } catch {
      throw new Error('Context is not available.');
    }
  }

  async function authorize(context, action, resource) {
    try {
      await activePrincipal(context?.principal, context?.organizationId);
    } catch {
      return { effect: 'deny', reason: 'principal-inactive' };
    }
    if (context?.deploymentId !== deploymentId) return denied();
    const organization = records.organizations.find(
      (candidate) => candidate.id === context.organizationId && candidate.state === 'active',
    );
    if (!organization) return denied();
    const project = await projects.get(organization.id, context.projectId);
    if (
      !project ||
      project.organizationId !== organization.id ||
      project.teamId !== context.teamId
    ) {
      return denied();
    }
    if (context.teamId && !activeTeam(organization.id, context.teamId, false)) return denied();
    const memberships = applicableMemberships(organization.id, context.principal, project);
    if (
      !canUseProject(memberships) ||
      revisionDigest(memberships) !== context.membershipRevision ||
      organization.policyRevision !== context.policyRevision
    ) {
      return { effect: 'deny', reason: 'stale-context' };
    }
    if (!resourceBelongsToContext(resource, context)) return denied();
    if (!hasPermission(memberships, action)) return denied();
    const policy = await evaluatePolicy({ context, action, resource });
    return policy.effect === 'allow' ? { effect: 'allow', reason: 'role-permission' } : policy;
  }

  async function requireOrganizationPermission(principalInput, organizationId, permission) {
    const principal = await activePrincipal(principalInput, organizationId);
    const organization = activeOrganization(organizationId);
    const membership = activeMembership(organization.id, principal, {
      kind: 'organization',
      organizationId: organization.id,
    });
    if (!membership || !hasPermission([membership], permission)) throw new Error('Not authorized.');
    return principal;
  }

  async function activePrincipal(principal, organizationId) {
    return copy(
      await assertPrincipalActive(copy(principal), {
        ...(organizationId ? { organizationId } : {}),
      }),
    );
  }

  async function validateScope(organizationId, scope) {
    if (scope?.kind === 'organization' && scope.organizationId === organizationId)
      return copy(scope);
    if (scope?.kind === 'team' && activeTeam(organizationId, scope.teamId, false))
      return copy(scope);
    if (scope?.kind === 'project') {
      const project = await projects.get(organizationId, scope.projectId);
      if (project?.organizationId === organizationId) return copy(scope);
    }
    throw new Error('Scope is not available.');
  }

  function tenantOrganization(organizationId) {
    const organization = records.organizations.find((candidate) => candidate.id === organizationId);
    if (!organization) throw new Error('Organization not found.');
    return organization;
  }

  function activeOrganization(organizationId) {
    const organization = tenantOrganization(organizationId);
    if (organization.state !== 'active') throw new Error('Organization is not active.');
    return organization;
  }

  function activeTeam(organizationId, teamId, fail = true) {
    const team = records.teams.find(
      (candidate) =>
        candidate.id === teamId &&
        candidate.organizationId === organizationId &&
        candidate.state === 'active',
    );
    if (!team && fail) throw new Error('Team not found.');
    return team;
  }

  function activeIdentityProvider(organizationId, identityProviderId) {
    const provider = records.identityProviders.find(
      (candidate) =>
        candidate.id === identityProviderId &&
        candidate.organizationId === organizationId &&
        candidate.state === 'active',
    );
    if (!provider) throw new Error('Identity provider is not active.');
    activeOrganization(organizationId);
    return provider;
  }

  function tenantMembership(organizationId, membershipId) {
    const membership = records.memberships.find(
      (candidate) => candidate.id === membershipId && candidate.organizationId === organizationId,
    );
    if (!membership) throw new Error('Membership not found.');
    return membership;
  }

  function activeMembership(organizationId, principal, scope) {
    return records.memberships.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.state === 'active' &&
        samePrincipal(candidate.principal, principal) &&
        sameScope(candidate.scope, scope),
    );
  }

  function findMembership(organizationId, principal, scope, includeRevoked = true) {
    return records.memberships.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        (includeRevoked || candidate.state !== 'revoked') &&
        samePrincipal(candidate.principal, principal) &&
        sameScope(candidate.scope, scope),
    );
  }

  function managedMemberships(identityProviderId, principal) {
    return records.memberships.filter(
      (candidate) =>
        candidate.managedBy?.identityProviderId === identityProviderId &&
        samePrincipal(candidate.principal, principal),
    );
  }

  function findManagedMembership(organizationId, identityProviderId, principal, scope) {
    return records.memberships.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.managedBy?.identityProviderId === identityProviderId &&
        samePrincipal(candidate.principal, principal) &&
        sameScope(candidate.scope, scope),
    );
  }

  function applicableMemberships(organizationId, principal, project) {
    return records.memberships.filter((membership) => {
      if (
        membership.organizationId !== organizationId ||
        membership.state !== 'active' ||
        !samePrincipal(membership.principal, principal)
      )
        return false;
      if (membership.scope.kind === 'organization') return true;
      if (membership.scope.kind === 'team') return membership.scope.teamId === project.teamId;
      return membership.scope.kind === 'project' && membership.scope.projectId === project.id;
    });
  }

  function applicablePolicies(organizationId, resource) {
    return records.policies
      .filter((policy) => {
        if (policy.organizationId !== organizationId) return false;
        if (policy.scope.kind === 'organization') return true;
        if (policy.scope.kind === 'team') return policy.scope.teamId === resource?.teamId;
        return policy.scope.kind === 'project' && policy.scope.projectId === resource?.projectId;
      })
      .sort((left, right) => policyScopeRank(left.scope.kind) - policyScopeRank(right.scope.kind));
  }

  function activeOwnerCount(organizationId) {
    return records.memberships.filter(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.scope.kind === 'organization' &&
        membership.state === 'active' &&
        membership.roles.includes('owner'),
    ).length;
  }

  return Object.freeze({
    createOrganization,
    createTeam,
    updateTeam,
    createMembership,
    updateMembership,
    setOrganizationState,
    setPolicyRevision,
    savePolicy,
    evaluatePolicy,
    createInvitation,
    acceptInvitation,
    revokeInvitation,
    configureIdentityProvider,
    beginDomainVerification,
    completeDomainVerification,
    saveIdentityProviderGroupMapping,
    evaluateFederatedAccess,
    reconcileProvisionedMemberships,
    deprovisionProvisionedPrincipal,
    listAvailableContexts,
    resolveContext,
    authorize,
    requireOrganizationPermission,
    snapshot(principal) {
      const organizationIds = new Set(
        records.memberships
          .filter(
            (membership) =>
              membership.state === 'active' && samePrincipal(membership.principal, principal),
          )
          .map((membership) => membership.organizationId),
      );
      return {
        organizations: records.organizations
          .filter((organization) => organizationIds.has(organization.id))
          .map(copy),
        teams: records.teams.filter((team) => organizationIds.has(team.organizationId)).map(copy),
        memberships: records.memberships
          .filter(
            (membership) =>
              organizationIds.has(membership.organizationId) &&
              samePrincipal(membership.principal, principal),
          )
          .map(copy),
        identityProviders: records.identityProviders
          .filter(
            (provider) =>
              organizationIds.has(provider.organizationId) && provider.state === 'active',
          )
          .map(publicIdentityProvider),
        policies: records.policies
          .filter((policy) => organizationIds.has(policy.organizationId))
          .map(copy),
      };
    },
  });
}

function membershipRecord({ id, organizationId, principal, scope, roles, at }) {
  return {
    id,
    organizationId,
    principal: copy(principal),
    scope: copy(scope),
    roles: [...roles],
    state: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function validateRoles(scopeKind, roles) {
  if (!Array.isArray(roles) || roles.length === 0)
    throw new Error('At least one role is required.');
  const available = ORGANIZATION_ROLE_PERMISSIONS[scopeKind];
  if (!available) throw new Error('Unsupported membership scope.');
  const unique = [...new Set(roles)];
  if (unique.some((role) => !Object.hasOwn(available, role))) throw new Error('Unsupported role.');
  return unique.sort();
}

function validatePrincipalRoles(principal, scopeKind, roles) {
  const validated = validateRoles(scopeKind, roles);
  if (principal?.kind === 'user') return validated;
  const allowed = MACHINE_PRINCIPAL_ROLES[scopeKind];
  if (!allowed || validated.some((role) => !allowed.has(role))) {
    throw new Error('Machine principals require bounded roles.');
  }
  return validated;
}

function validatePolicyRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new TypeError('Policy rules are required.');
  }
  const effects = new Set(['allow', 'ask', 'deny']);
  const permissions = rules.permissions ?? {};
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new TypeError('Policy permissions must be an object.');
  }
  const normalizedPermissions = {};
  for (const [permission, effect] of Object.entries(permissions)) {
    requiredText(permission, 'permission');
    if (!effects.has(effect)) throw new Error('Unsupported policy effect.');
    normalizedPermissions[permission] = effect;
  }
  const normalized = { permissions: normalizedPermissions };
  for (const control of ['personalProviders', 'fullSystemAccess']) {
    if (rules[control] === undefined) continue;
    if (!effects.has(rules[control])) throw new Error('Unsupported policy effect.');
    normalized[control] = rules[control];
  }
  return normalized;
}

function permissionsFor(membership) {
  return membership.roles.flatMap(
    (role) => ORGANIZATION_ROLE_PERMISSIONS[membership.scope.kind]?.[role] ?? [],
  );
}

function hasPermission(memberships, permission) {
  return memberships.some((membership) => {
    const permissions = permissionsFor(membership);
    return permissions.includes('*') || permissions.includes(permission);
  });
}

function canUseProject(memberships) {
  return hasPermission(memberships, 'context.use') || hasPermission(memberships, 'project.read');
}

function policyScopeRank(kind) {
  return kind === 'organization' ? 0 : kind === 'team' ? 1 : 2;
}

function revisionDigest(memberships) {
  return digest(
    memberships
      .map((membership) => `${membership.id}:${membership.revision}`)
      .sort()
      .join('|'),
  );
}

function resourceBelongsToContext(resource, context) {
  if (!resource || resource.organizationId !== context.organizationId) return false;
  if (resource.teamId !== undefined && resource.teamId !== context.teamId) return false;
  if (resource.projectId !== undefined && resource.projectId !== context.projectId) return false;
  return true;
}

function samePrincipal(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (left.kind === 'user') return left.userId === right.userId;
  if (left.kind === 'workload') return left.workloadIdentityId === right.workloadIdentityId;
  if (left.kind === 'service-principal')
    return left.servicePrincipalId === right.servicePrincipalId;
  return false;
}

function sameScope(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (left.kind === 'organization') return left.organizationId === right.organizationId;
  if (left.kind === 'team') return left.teamId === right.teamId;
  if (left.kind === 'project') return left.projectId === right.projectId;
  return false;
}

function publicInvitation(invitation) {
  const { tokenHash: _, ...visible } = invitation;
  return copy(visible);
}

function publicDomainVerification(verification) {
  const { challengeHash: _, ...visible } = verification;
  return copy(visible);
}

function publicIdentityProvider(provider) {
  return copy({
    id: provider.id,
    organizationId: provider.organizationId,
    protocol: provider.protocol,
    issuer: provider.issuer,
    displayName: provider.displayName,
    verifiedDomains: provider.verifiedDomains,
    jit: provider.jit,
    scimEnabled: provider.scimEnabled,
    ...(provider.requiredAuthenticationStrength
      ? { requiredAuthenticationStrength: provider.requiredAuthenticationStrength }
      : {}),
    requireMfa: provider.requireMfa,
    state: provider.state,
    revision: provider.revision,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  });
}

function denied() {
  return { effect: 'deny', reason: 'not-authorized' };
}

function unavailableInvitation() {
  return new Error('Invitation is not available.');
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validSlug(value) {
  const slug = requiredText(value, 'slug').toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid slug.');
  return slug;
}

function validEmail(value) {
  const email = requiredText(value, 'email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Invalid email.');
  return email;
}

function validDomain(value) {
  const domain = requiredText(value, 'domain').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('Invalid domain.');
  return domain;
}

function validIssuer(value) {
  try {
    return new URL(requiredText(value, 'issuer')).origin;
  } catch {
    throw new Error('Identity provider issuer must be an absolute origin.');
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value.trim();
}

function positiveDuration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('ttlMs must be positive.');
  return value;
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Clock returned an invalid time.');
  return date;
}

function timestamp(now) {
  return nowDate(now).toISOString();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function copy(value) {
  return structuredClone(value);
}
