import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest();
const iso = (value) => value.toISOString();
const allowedPermissions = {
  terminal: new Set(['attach', 'input', 'resize', 'read']),
  'direct-channel': new Set(['connect', 'read', 'write']),
};

const requiredText = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} is required.`);
  return value;
};

const principalKey = (principal) => {
  if (principal?.kind === 'user') return `user:${requiredText(principal.userId, 'User ID', 200)}`;
  if (principal?.kind === 'workload')
    return `workload:${requiredText(principal.workloadIdentityId, 'Workload identity ID', 200)}`;
  if (principal?.kind === 'service-principal')
    return `service:${requiredText(principal.servicePrincipalId, 'Service principal ID', 200)}`;
  throw new Error('A user or workload principal is required.');
};

const publicGrant = ({ tokenDigest: _secret, ...grant }) => clone(grant);
const tokenFor = () => `chn_${randomBytes(32).toString('base64url')}`;

/**
 * Issues opaque, short-lived direct-channel authority. Validation is the
 * runner-facing port: every immutable channel binding and the live session
 * lease is checked before a descriptor or direct connection may be used.
 */
export function createChannelGrants({ state, catalog, save, now = () => new Date() }) {
  state.channelGrants ??= [];

  function sessionFor(id) {
    const value =
      state.sessions?.[id] ??
      Object.values(state.sessions ?? {}).find((s) => String(s.id) === String(id));
    if (!value) throw new Error('Channel grant is invalid.');
    return value;
  }

  function binding(session, audience, terminalId) {
    if (!allowedPermissions[audience]) throw new Error('Unknown channel grant audience.');
    const projectId = requiredText(session.projectId, 'Project ID', 200);
    const project = catalog.project(projectId);
    const organizationId = requiredText(project.organizationId, 'Organization ID', 200);
    const runnerId = requiredText(session.runnerId, 'Runner ID', 200);
    const runner = state.runners?.find(
      (candidate) => candidate.id === runnerId && candidate.organizationId === organizationId,
    );
    if (
      !runner ||
      !runner.projectIds?.includes(projectId) ||
      runner.environmentId !== session.assignment?.environmentId
    )
      throw new Error('Channel grant is invalid.');
    if (!session.workspace?.path) throw new Error('Channel grant requires an assigned workspace.');
    if (!session.lease?.id || session.lease.expiresAt <= now().getTime())
      throw new Error('Channel grant requires an active control lease.');
    const executionGrantDigest = session.executionGrant?.digest;
    if (
      !executionGrantDigest ||
      session.assignment?.policyDigest !== executionGrantDigest ||
      session.assignment?.state === 'uncertain'
    )
      throw new Error('Channel grant requires a current execution grant and assignment lease.');
    if (audience === 'terminal') requiredText(terminalId, 'Terminal ID', 200);
    return {
      organizationId,
      projectId,
      sessionId: String(session.id),
      runnerId,
      environmentId: runner.environmentId,
      workspace: session.workspace.path,
      leaseId: session.lease.id,
      executionGrantDigest,
      ...(terminalId ? { terminalId } : {}),
    };
  }

  function normalizePermissions(audience, permissions) {
    const selected = permissions ?? (audience === 'terminal' ? ['attach'] : ['connect']);
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some((permission) => !allowedPermissions[audience].has(permission))
    )
      throw new Error('Channel grant permissions are invalid.');
    return [...new Set(selected)];
  }

  function expiry(session, expiresInSeconds) {
    const lifetime = expiresInSeconds ?? 60;
    if (!Number.isInteger(lifetime) || lifetime < 10 || lifetime > 300)
      throw new Error('Channel grant lifetime must be 10–300 seconds.');
    return new Date(Math.min(now().getTime() + lifetime * 1000, session.lease.expiresAt));
  }

  async function issue(input) {
    const actorKey = principalKey(input.actor);
    const audience = requiredText(input.audience, 'Audience', 40);
    const target = binding(input.session, audience, input.terminalId);
    const token = tokenFor();
    const createdAt = now();
    const value = {
      id: randomUUID(),
      ...target,
      audience,
      actor: clone(input.actor),
      actorKey,
      permissions: normalizePermissions(audience, input.permissions),
      state: 'active',
      tokenDigest: digest(token).toString('hex'),
      createdAt: iso(createdAt),
      expiresAt: iso(expiry(input.session, input.expiresInSeconds)),
      revision: 1,
    };
    state.channelGrants.push(value);
    await save();
    return { token, grant: publicGrant(value) };
  }

  function findByToken(token) {
    if (typeof token !== 'string' || !token.startsWith('chn_')) return undefined;
    const presented = digest(token);
    return state.channelGrants.find((candidate) => {
      const stored = Buffer.from(candidate.tokenDigest, 'hex');
      return stored.length === presented.length && timingSafeEqual(stored, presented);
    });
  }

  function validate(token, expected = {}) {
    const value = findByToken(token);
    if (!value || value.state !== 'active') throw new Error('Channel grant is invalid.');
    if (Date.parse(value.expiresAt) <= now().getTime()) {
      value.state = 'expired';
      throw new Error('Channel grant has expired.');
    }
    for (const field of [
      'audience',
      'organizationId',
      'projectId',
      'sessionId',
      'runnerId',
      'environmentId',
      'workspace',
      'leaseId',
      'executionGrantDigest',
      'terminalId',
    ]) {
      if (expected[field] !== undefined && value[field] !== expected[field])
        throw new Error('Channel grant is invalid.');
    }
    if (
      expected.permission &&
      (!allowedPermissions[value.audience]?.has(expected.permission) ||
        !value.permissions.includes(expected.permission))
    )
      throw new Error('Channel grant is invalid.');

    // Re-read authoritative session state on every use. Restart, release,
    // reassignment, policy changes and cross-tenant substitutions all fail closed.
    const live = binding(sessionFor(value.sessionId), value.audience, value.terminalId);
    for (const field of Object.keys(live))
      if (value[field] !== live[field]) throw new Error('Channel grant is invalid.');
    return publicGrant(value);
  }

  async function renew(input) {
    const organizationId = catalog.project(input.session.projectId).organizationId;
    const value = state.channelGrants.find(
      (candidate) => candidate.id === input.id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Channel grant is invalid.');
    if (value.revision !== input.revision) throw new Error('Channel grant changed. Reload first.');
    if (value.state !== 'active' || Date.parse(value.expiresAt) <= now().getTime())
      throw new Error('Channel grant is no longer active.');
    if (value.actorKey !== principalKey(input.actor)) throw new Error('Channel grant is invalid.');
    const live = binding(input.session, value.audience, value.terminalId);
    for (const field of Object.keys(live))
      if (value[field] !== live[field]) throw new Error('Channel grant is invalid.');
    const token = tokenFor();
    value.tokenDigest = digest(token).toString('hex');
    value.expiresAt = iso(expiry(input.session, input.expiresInSeconds));
    value.renewedAt = iso(now());
    value.revision++;
    await save();
    return { token, grant: publicGrant(value) };
  }

  async function revoke(id, organizationId, revision, actor) {
    const value = state.channelGrants.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Channel grant is invalid.');
    if (value.revision !== revision) throw new Error('Channel grant changed. Reload first.');
    if (value.actorKey !== principalKey(actor)) throw new Error('Channel grant is invalid.');
    if (value.state !== 'active') throw new Error('Channel grant is no longer active.');
    value.state = 'revoked';
    value.revokedAt = iso(now());
    value.revision++;
    await save();
    return publicGrant(value);
  }

  function revokeForSession(input) {
    const organizationId = catalog.project(input.session.projectId).organizationId;
    return revoke(input.id, organizationId, input.revision, input.actor);
  }

  return {
    issue,
    validate,
    renew,
    revoke,
    revokeForSession,
    list: (organizationId) =>
      state.channelGrants
        .filter((value) => value.organizationId === organizationId)
        .map(publicGrant),
  };
}
