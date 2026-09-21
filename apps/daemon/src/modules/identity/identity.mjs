import { createHash, randomBytes, randomUUID } from 'node:crypto';

const USER_STATES = new Set(['active', 'suspended', 'deleted']);
const WORKLOAD_STATES = new Set(['active', 'suspended', 'revoked']);
const DEFAULT_SERVICE_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SERVICE_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createIdentity({
  state,
  save = async () => {},
  generateId = (prefix) => `${prefix}_${randomUUID()}`,
  now = () => new Date(),
  authorizeAccountLink = async () => false,
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Identity requires mutable state.');
  const records = (state.identity ??= {
    users: [],
    deviceSessions: [],
    workloadIdentities: [],
    servicePrincipals: [],
  });
  records.users ??= [];
  records.deviceSessions ??= [];
  records.workloadIdentities ??= [];
  records.servicePrincipals ??= [];
  records.externalIdentityLinks ??= [];

  async function createUser(input) {
    const displayName = requiredText(input?.displayName, 'displayName');
    const primaryEmail = optionalEmail(input?.primaryEmail);
    const primaryEmailVerified = input?.primaryEmailVerified ?? false;
    if (typeof primaryEmailVerified !== 'boolean') {
      throw new TypeError('primaryEmailVerified must be a boolean.');
    }
    if (primaryEmailVerified && !primaryEmail) {
      throw new Error('A primary email is required before it can be verified.');
    }
    if (
      primaryEmail &&
      records.users.some(
        (candidate) => candidate.primaryEmail === primaryEmail && candidate.state !== 'deleted',
      )
    ) {
      throw new Error('An active user already has that primary email.');
    }
    const at = timestamp(now);
    const user = {
      id: generateId('usr'),
      displayName,
      ...(primaryEmail ? { primaryEmail } : {}),
      primaryEmailVerified,
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.users.push(user);
    await save();
    return copy(user);
  }

  async function setUserState(userId, nextState) {
    if (!USER_STATES.has(nextState)) throw new Error(`Unsupported user state: ${nextState}`);
    const user = findUser(userId);
    if (user.state === 'deleted' && nextState !== 'deleted') {
      throw new Error('Deleted users cannot be reactivated.');
    }
    if (user.state !== nextState) {
      user.state = nextState;
      user.revision += 1;
      user.updatedAt = timestamp(now);
      if (nextState !== 'active') revokeUserSessions(user.id, user.updatedAt);
      await save();
    }
    return copy(user);
  }

  async function openDeviceSession(input) {
    const user = findUser(input?.userId);
    assertActiveUser(user);
    const deviceId = requiredText(input?.deviceId, 'deviceId');
    const ttlMs = positiveDuration(input?.ttlMs);
    const credential = `dvc_${randomBytes(32).toString('base64url')}`;
    const issuedAt = nowDate(now);
    const session = {
      id: generateId('dvs'),
      userId: user.id,
      deviceId,
      credentialHash: digest(credential),
      state: 'active',
      revision: 1,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    };
    records.deviceSessions.push(session);
    await save();
    return { session: publicSession(session), credential };
  }

  async function authenticateDeviceSession(credential) {
    return (await authenticateDeviceCredential(credential)).principal;
  }

  async function authenticateDeviceCredential(credential) {
    const credentialHash = digest(requiredText(credential, 'credential'));
    const session = records.deviceSessions.find(
      (candidate) => candidate.credentialHash === credentialHash,
    );
    if (!session) throw new Error('Device session is not active.');
    const user = findUser(session.userId);
    assertActiveUser(user);
    if (session.state !== 'active') throw new Error('Device session is not active.');
    if (Date.parse(session.expiresAt) <= nowDate(now).getTime())
      throw new Error('Device session has expired.');
    return {
      principal: { kind: 'user', userId: user.id },
      session: publicSession(session),
    };
  }

  async function revokeDeviceSession(sessionId) {
    const session = records.deviceSessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error('Device session not found.');
    if (session.state !== 'revoked') {
      session.state = 'revoked';
      session.revision += 1;
      session.revokedAt = timestamp(now);
      await save();
    }
    return publicSession(session);
  }

  async function createWorkloadIdentity(input) {
    const at = timestamp(now);
    const workload = {
      id: generateId('wli'),
      displayName: requiredText(input?.displayName, 'displayName'),
      organizationId: requiredText(input?.organizationId, 'organizationId'),
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.workloadIdentities.push(workload);
    await save();
    return copy(workload);
  }

  async function setWorkloadIdentityState(workloadIdentityId, nextState) {
    if (!WORKLOAD_STATES.has(nextState)) {
      throw new Error(`Unsupported workload identity state: ${nextState}`);
    }
    const workload = findWorkload(workloadIdentityId);
    if (workload.state === 'revoked' && nextState !== 'revoked') {
      throw new Error('Revoked workload identities cannot be reactivated.');
    }
    if (workload.state !== nextState) {
      workload.state = nextState;
      workload.revision += 1;
      workload.updatedAt = timestamp(now);
      await save();
    }
    return copy(workload);
  }

  async function revokeWorkloadIdentity(input) {
    const workload = tenantWorkload(input);
    assertRevision(workload, input?.expectedRevision, 'Workload identity');
    return setWorkloadIdentityState(workload.id, 'revoked');
  }

  async function createServicePrincipal(input) {
    const at = timestamp(now);
    const credentialTtlMs = boundedServiceCredentialDuration(input?.ttlMs);
    const credential = `svc_${randomBytes(32).toString('base64url')}`;
    const servicePrincipal = {
      id: generateId('svc'),
      displayName: requiredText(input?.displayName, 'displayName'),
      organizationId: requiredText(input?.organizationId, 'organizationId'),
      credentialHash: digest(credential),
      credentialExpiresAt: new Date(nowDate(now).getTime() + credentialTtlMs).toISOString(),
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    records.servicePrincipals.push(servicePrincipal);
    await save();
    return { servicePrincipal: publicServicePrincipal(servicePrincipal), credential };
  }

  async function authenticateServicePrincipal(credential) {
    const credentialHash = digest(requiredText(credential, 'credential'));
    const servicePrincipal = records.servicePrincipals.find(
      (candidate) => candidate.credentialHash === credentialHash,
    );
    if (!servicePrincipal || servicePrincipal.state !== 'active')
      throw new Error('Service principal is not active.');
    const credentialExpiresAt = Date.parse(servicePrincipal.credentialExpiresAt);
    if (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= nowDate(now).getTime()) {
      throw new Error('Service principal credential has expired.');
    }
    return { kind: 'service-principal', servicePrincipalId: servicePrincipal.id };
  }

  async function rotateServicePrincipalCredential(input) {
    const servicePrincipal = tenantServicePrincipal(input);
    assertRevision(servicePrincipal, input?.expectedRevision, 'Service principal');
    if (servicePrincipal.state !== 'active') throw new Error('Service principal is not active.');
    const credentialTtlMs = boundedServiceCredentialDuration(input?.ttlMs);
    const credential = `svc_${randomBytes(32).toString('base64url')}`;
    servicePrincipal.credentialHash = digest(credential);
    servicePrincipal.credentialExpiresAt = new Date(
      nowDate(now).getTime() + credentialTtlMs,
    ).toISOString();
    servicePrincipal.revision += 1;
    servicePrincipal.updatedAt = timestamp(now);
    await save();
    return { servicePrincipal: publicServicePrincipal(servicePrincipal), credential };
  }

  async function authenticateCredential(credential) {
    if (typeof credential !== 'string') throw new Error('Credential is not active.');
    if (credential.startsWith('dvc_')) return authenticateDeviceCredential(credential);
    if (credential.startsWith('svc_')) {
      const principal = await authenticateServicePrincipal(credential);
      return { principal };
    }
    throw new Error('Credential is not active.');
  }

  async function setServicePrincipalState(servicePrincipalId, nextState) {
    if (!WORKLOAD_STATES.has(nextState)) throw new Error('Unsupported service principal state.');
    const servicePrincipal = findServicePrincipal(servicePrincipalId);
    if (servicePrincipal.state === 'revoked' && nextState !== 'revoked')
      throw new Error('Revoked service principals cannot be reactivated.');
    if (servicePrincipal.state !== nextState) {
      servicePrincipal.state = nextState;
      servicePrincipal.revision += 1;
      servicePrincipal.updatedAt = timestamp(now);
      await save();
    }
    return publicServicePrincipal(servicePrincipal);
  }

  async function revokeServicePrincipal(input) {
    const servicePrincipal = tenantServicePrincipal(input);
    assertRevision(servicePrincipal, input?.expectedRevision, 'Service principal');
    return setServicePrincipalState(servicePrincipal.id, 'revoked');
  }

  async function provisionExternalUser(input) {
    const external = externalIdentityInput(input);
    const existing = findExternalLink(external);
    if (existing) {
      if (existing.state !== 'active' || existing.organizationId !== external.organizationId) {
        throw new Error('External identity is not active.');
      }
      return {
        created: false,
        user: copy(findUser(existing.userId)),
        link: copy(existing),
      };
    }
    const email = validExternalEmail(input?.email, input?.emailVerified);
    if (
      records.users.some(
        (candidate) => candidate.primaryEmail === email && candidate.state !== 'deleted',
      )
    ) {
      throw new Error('Controlled account linking is required for this email.');
    }
    const user = await createUser({
      displayName: input?.displayName,
      primaryEmail: email,
      primaryEmailVerified: true,
    });
    const link = externalLinkRecord({
      id: generateId('xid'),
      userId: user.id,
      external,
      email,
      source: externalProvisioningSource(input?.source),
      at: timestamp(now),
    });
    records.externalIdentityLinks.push(link);
    await save();
    return { created: true, user, link: copy(link) };
  }

  async function linkExternalIdentity(input) {
    const user = findUser(input?.userId);
    assertActiveUser(user);
    const external = externalIdentityInput(input);
    if (findExternalLink(external)) throw new Error('External identity is already linked.');
    const email = validExternalEmail(input?.email, input?.emailVerified);
    const allowed = await authorizeAccountLink({
      user: copy(user),
      external: copy(external),
      email,
      proof: input?.proof,
    });
    if (allowed !== true) throw new Error('Account linking was not authorized.');
    const link = externalLinkRecord({
      id: generateId('xid'),
      userId: user.id,
      external,
      email,
      source: 'controlled-link',
      at: timestamp(now),
    });
    records.externalIdentityLinks.push(link);
    await save();
    return copy(link);
  }

  async function resolveExternalIdentity(input) {
    const identityProviderId = requiredText(input?.identityProviderId, 'identityProviderId');
    const issuer = validIssuer(input?.issuer);
    const subject = requiredText(input?.subject, 'subject');
    const link = records.externalIdentityLinks.find(
      (candidate) =>
        candidate.identityProviderId === identityProviderId &&
        candidate.issuer === issuer &&
        candidate.subject === subject,
    );
    if (!link || link.state !== 'active') throw new Error('External identity is not active.');
    const user = findUser(link.userId);
    assertActiveUser(user);
    return {
      principal: { kind: 'user', userId: user.id },
      link: copy(link),
      authentication: {
        method: link.protocol === 'oidc' ? 'oidc-pkce' : 'saml',
        ...(input?.authenticationStrength
          ? {
              authenticationStrength: requiredText(
                input.authenticationStrength,
                'authenticationStrength',
              ),
            }
          : {}),
        mfa: input?.mfa === true,
      },
    };
  }

  async function deprovisionExternalIdentity(input) {
    const organizationId = requiredText(input?.organizationId, 'organizationId');
    const identityProviderId = requiredText(input?.identityProviderId, 'identityProviderId');
    const subject = requiredText(input?.subject, 'subject');
    const candidates = records.externalIdentityLinks.filter(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.identityProviderId === identityProviderId &&
        candidate.subject === subject &&
        candidate.state === 'active',
    );
    if (candidates.length !== 1) throw new Error('External identity is not active.');
    const link = candidates[0];
    link.state = 'revoked';
    link.revision += 1;
    link.updatedAt = timestamp(now);
    link.revokedAt = link.updatedAt;
    revokeUserSessions(link.userId, link.updatedAt);
    await save();
    return copy(link);
  }

  async function assertPrincipalActive(principal, scope = {}) {
    if (principal?.kind === 'user') {
      assertActiveUser(findUser(principal.userId));
      return copy(principal);
    }
    if (principal?.kind === 'workload') {
      const workload = findWorkload(principal.workloadIdentityId);
      if (workload.state !== 'active') throw new Error('Workload identity is not active.');
      if (scope.organizationId && workload.organizationId !== scope.organizationId) {
        throw new Error('Workload identity is not active for this organization.');
      }
      return copy(principal);
    }
    if (principal?.kind === 'service-principal') {
      const servicePrincipal = findServicePrincipal(principal.servicePrincipalId);
      if (servicePrincipal.state !== 'active') throw new Error('Service principal is not active.');
      if (scope.organizationId && servicePrincipal.organizationId !== scope.organizationId)
        throw new Error('Service principal is not active for this organization.');
      return copy(principal);
    }
    throw new Error('Unsupported principal.');
  }

  async function getVerifiedEmail(principal) {
    await assertPrincipalActive(principal);
    if (principal.kind !== 'user') return undefined;
    const user = findUser(principal.userId);
    return user.primaryEmailVerified ? user.primaryEmail : undefined;
  }

  function findUser(userId) {
    const user = records.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error('User not found.');
    return user;
  }

  function findWorkload(workloadIdentityId) {
    const workload = records.workloadIdentities.find(
      (candidate) => candidate.id === workloadIdentityId,
    );
    if (!workload) throw new Error('Workload identity not found.');
    return workload;
  }

  function findServicePrincipal(servicePrincipalId) {
    const servicePrincipal = records.servicePrincipals.find(
      (candidate) => candidate.id === servicePrincipalId,
    );
    if (!servicePrincipal) throw new Error('Service principal not found.');
    return servicePrincipal;
  }

  function tenantWorkload(input) {
    const workload = records.workloadIdentities.find(
      (candidate) =>
        candidate.id === input?.workloadIdentityId &&
        candidate.organizationId === input?.organizationId,
    );
    if (!workload) throw new Error('Workload identity not found.');
    return workload;
  }

  function tenantServicePrincipal(input) {
    const servicePrincipal = records.servicePrincipals.find(
      (candidate) =>
        candidate.id === input?.servicePrincipalId &&
        candidate.organizationId === input?.organizationId,
    );
    if (!servicePrincipal) throw new Error('Service principal not found.');
    return servicePrincipal;
  }

  function findExternalLink(external) {
    return records.externalIdentityLinks.find(
      (candidate) =>
        candidate.identityProviderId === external.identityProviderId &&
        candidate.issuer === external.issuer &&
        candidate.subject === external.subject,
    );
  }

  function revokeUserSessions(userId, at) {
    for (const session of records.deviceSessions) {
      if (session.userId === userId && session.state === 'active') {
        session.state = 'revoked';
        session.revision += 1;
        session.revokedAt = at;
      }
    }
  }

  return Object.freeze({
    createUser,
    setUserState,
    openDeviceSession,
    authenticateDeviceSession,
    authenticateCredential,
    revokeDeviceSession,
    createWorkloadIdentity,
    setWorkloadIdentityState,
    revokeWorkloadIdentity,
    createServicePrincipal,
    authenticateServicePrincipal,
    rotateServicePrincipalCredential,
    setServicePrincipalState,
    revokeServicePrincipal,
    provisionExternalUser,
    linkExternalIdentity,
    resolveExternalIdentity,
    deprovisionExternalIdentity,
    assertPrincipalActive,
    getVerifiedEmail,
    snapshot(principal, { organizationId, includeAdministration = false } = {}) {
      const user =
        principal?.kind === 'user'
          ? records.users.find((candidate) => candidate.id === principal.userId)
          : undefined;
      return {
        ...(user ? { currentUser: copy(user) } : {}),
        deviceSessions: records.deviceSessions
          .filter((candidate) => candidate.userId === user?.id)
          .map(publicSession),
        ...(includeAdministration && organizationId
          ? {
              workloadIdentities: records.workloadIdentities
                .filter((candidate) => candidate.organizationId === organizationId)
                .map(copy),
              servicePrincipals: records.servicePrincipals
                .filter((candidate) => candidate.organizationId === organizationId)
                .map(publicServicePrincipal),
            }
          : {}),
      };
    },
  });
}

function externalIdentityInput(input) {
  const protocol = input?.protocol;
  if (protocol !== 'oidc' && protocol !== 'saml') {
    throw new Error('Unsupported external identity protocol.');
  }
  return {
    organizationId: requiredText(input?.organizationId, 'organizationId'),
    identityProviderId: requiredText(input?.identityProviderId, 'identityProviderId'),
    protocol,
    issuer: validIssuer(input?.issuer),
    subject: requiredText(input?.subject, 'subject'),
  };
}

function validIssuer(value) {
  try {
    return new URL(requiredText(value, 'issuer')).origin;
  } catch {
    throw new Error('External identity issuer must be an absolute origin.');
  }
}

function externalLinkRecord({ id, userId, external, email, source, at }) {
  return {
    id,
    userId,
    ...copy(external),
    email,
    source,
    state: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function externalProvisioningSource(source) {
  if (source !== 'jit' && source !== 'scim') throw new Error('Unsupported provisioning source.');
  return source;
}

function validExternalEmail(value, verified) {
  if (verified !== true) throw new Error('External identity email must be verified.');
  const email = optionalEmail(value);
  if (!email) throw new Error('External identity email must be verified.');
  return email;
}

function assertActiveUser(user) {
  if (user.state !== 'active') throw new Error('User is not active.');
}

function publicSession(session) {
  const { credentialHash: _, ...visible } = session;
  return copy(visible);
}

function publicServicePrincipal(servicePrincipal) {
  const { credentialHash: _, ...visible } = servicePrincipal;
  return copy(visible);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertRevision(record, expectedRevision, label) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error(`${label} revision is required.`);
  }
  if (record.revision !== expectedRevision) throw new Error(`${label} revision conflict.`);
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value.trim();
}

function optionalEmail(value) {
  if (value === undefined) return undefined;
  const normalized = requiredText(value, 'primaryEmail').toLowerCase();
  if (!normalized.includes('@')) throw new TypeError('primaryEmail must be an email address.');
  return normalized;
}

function positiveDuration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('ttlMs must be positive.');
  return value;
}

function boundedServiceCredentialDuration(value) {
  const duration = value ?? DEFAULT_SERVICE_CREDENTIAL_TTL_MS;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > MAX_SERVICE_CREDENTIAL_TTL_MS
  ) {
    throw new TypeError('Service principal credential ttlMs must be between 1 and 90 days.');
  }
  return duration;
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

function copy(value) {
  return structuredClone(value);
}
