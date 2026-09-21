import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest();
const iso = (value) => value.toISOString();

const requiredText = (value, label, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} is required.`);
  return value;
};

const ids = (value = []) => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim()))
    throw new Error('Expected a list of IDs.');
  return [...new Set(value)];
};

const publicEnrollment = ({ tokenDigest: _secret, ...value }) => clone(value);
const publicMachineIdentity = ({ credentialDigest: _secret, ...value }) => clone(value);
const publicRunner = (value) => ({
  ...clone(value),
  ...(value.machineIdentity
    ? { machineIdentity: publicMachineIdentity(value.machineIdentity) }
    : {}),
});

const machineCredential = () => `rnr_${randomBytes(32).toString('base64url')}`;

/**
 * Enrollment turns one short-lived administrator authorization into one
 * bounded runner identity. The bearer token is returned once and only its
 * digest is retained.
 */
export function createRunnerEnrollment({ state, catalog, save, now = () => new Date() }) {
  state.runnerEnrollments ??= [];

  const environment = (id, organizationId) => {
    const value = state.environments.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Environment not found.');
    return value;
  };
  const pool = (id, organizationId) => {
    const value = state.runnerPools.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Runner pool not found.');
    return value;
  };
  const enrollment = (id, organizationId) => {
    const value = state.runnerEnrollments.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Runner enrollment not found.');
    return value;
  };
  const runner = (id, organizationId) => {
    const value = state.runners.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Runner not found.');
    return value;
  };

  async function issue(input) {
    const organizationId = requiredText(input.organizationId, 'Organization ID', 200);
    const target = environment(input.environmentId, organizationId);
    const poolIds = ids(input.poolIds);
    poolIds.forEach((id) => pool(id, organizationId));
    const projectIds = ids(input.projectIds);
    for (const projectId of projectIds) {
      const project = catalog.project(projectId);
      if ((project.organizationId ?? organizationId) !== organizationId)
        throw new Error('Project not found.');
    }
    const authorityCeiling = input.authorityCeiling ?? 'contained';
    if (!['contained', 'trusted'].includes(authorityCeiling))
      throw new Error('Unknown runner authority ceiling.');
    const expiresInSeconds = input.expiresInSeconds ?? 600;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 86400)
      throw new Error('Enrollment lifetime must be 30–86400 seconds.');
    const token = randomBytes(32).toString('base64url');
    const createdAt = now();
    const value = {
      id: randomUUID(),
      organizationId,
      environmentId: target.id,
      poolIds,
      projectIds,
      authorityCeiling,
      expectedPlatform: input.expectedPlatform
        ? {
            platform: requiredText(input.expectedPlatform.platform, 'Expected platform', 100),
            architecture: requiredText(
              input.expectedPlatform.architecture,
              'Expected architecture',
              100,
            ),
          }
        : undefined,
      state: 'pending',
      tokenDigest: digest(token).toString('hex'),
      createdAt: iso(createdAt),
      expiresAt: iso(new Date(createdAt.getTime() + expiresInSeconds * 1000)),
      revision: 1,
    };
    state.runnerEnrollments.push(value);
    await save();
    return { token, enrollment: publicEnrollment(value) };
  }

  function tokenEnrollment(token, organizationId) {
    if (typeof token !== 'string') throw new Error('Runner enrollment token is invalid.');
    const presented = digest(token);
    const value = state.runnerEnrollments.find((candidate) => {
      if (candidate.organizationId !== organizationId) return false;
      const stored = Buffer.from(candidate.tokenDigest, 'hex');
      return stored.length === presented.length && timingSafeEqual(stored, presented);
    });
    if (!value || value.state !== 'pending')
      throw new Error('Runner enrollment token is invalid or already used.');
    return value;
  }

  async function redeem(input) {
    const organizationId = requiredText(input.organizationId, 'Organization ID', 200);
    const value = tokenEnrollment(input.token, organizationId);
    if (Date.parse(value.expiresAt) <= now().getTime()) {
      value.state = 'expired';
      value.revision++;
      await save();
      throw new Error('Runner enrollment token has expired.');
    }
    if (input.environmentId !== value.environmentId)
      throw new Error('Runner enrollment token is not valid for this environment.');
    const target = environment(value.environmentId, organizationId);
    const accessMode = input.accessMode ?? 'contained';
    if (!['contained', 'trusted'].includes(accessMode))
      throw new Error('Unknown runner access mode.');
    if (accessMode === 'trusted' && value.authorityCeiling !== 'trusted')
      throw new Error('Runner exceeds the enrollment authority ceiling.');
    const attestation = input.attestation;
    if (!attestation || typeof attestation !== 'object')
      throw new Error('Runner attestation is required.');
    const platform = requiredText(attestation.platform, 'Attested platform', 100);
    const architecture = requiredText(attestation.architecture, 'Attested architecture', 100);
    if (
      value.expectedPlatform &&
      (value.expectedPlatform.platform !== platform ||
        value.expectedPlatform.architecture !== architecture)
    )
      throw new Error('Runner attestation does not match enrollment platform expectations.');
    const tools = ids(attestation.tools);
    const consumedAt = now();
    const identityId = randomUUID();
    const credential = machineCredential();
    const credentialDigest = digest(credential).toString('hex');
    const machineIdentity = {
      id: identityId,
      organizationId,
      state: 'active',
      fingerprint: credentialDigest.slice(0, 24),
      credentialDigest,
      issuedAt: iso(consumedAt),
      rotateAfter: iso(new Date(consumedAt.getTime() + 24 * 60 * 60 * 1000)),
      revision: 1,
    };
    const runnerValue = {
      id: randomUUID(),
      organizationId,
      name: requiredText(input.name, 'Runner name', 100),
      environmentId: target.id,
      kind: target.kind,
      host: target.host,
      repository: requiredText(input.repository, 'Repository'),
      projectIds: [...value.projectIds],
      enabled: true,
      lifecycle: 'persistent',
      registration: 'outbound',
      enrollmentId: value.id,
      machineIdentity,
      draining: false,
      tags: ids(attestation.tags),
      maxConcurrent:
        Number.isInteger(attestation.maxConcurrent) && attestation.maxConcurrent > 0
          ? Math.min(attestation.maxConcurrent, 32)
          : 4,
      revision: 1,
      accessMode,
      capabilities: {
        repository: input.repository,
        tools,
        platform,
        arch: architecture,
        enforcement: {
          isolation: accessMode === 'trusted' ? ['workspace', 'host'] : ['workspace'],
          network: accessMode === 'trusted' ? ['none', 'host'] : ['none'],
          failClosed: true,
          platform,
          architecture,
        },
      },
      checkedAt: iso(consumedAt),
      online: true,
    };

    // Consume before the first await so concurrent redeemers cannot both win.
    value.state = 'consumed';
    value.consumedAt = iso(consumedAt);
    value.runnerId = runnerValue.id;
    value.revision++;
    state.runners.push(runnerValue);
    for (const poolId of value.poolIds) {
      const targetPool = pool(poolId, organizationId);
      if (!targetPool.runnerIds.includes(runnerValue.id)) targetPool.runnerIds.push(runnerValue.id);
      targetPool.revision++;
    }
    await save();
    return {
      enrollment: publicEnrollment(value),
      runner: publicRunner(runnerValue),
      machineCredential: credential,
    };
  }

  async function revoke(id, organizationId, revision) {
    const value = enrollment(id, organizationId);
    if (value.revision !== revision) throw new Error('Runner enrollment changed. Reload first.');
    if (value.state !== 'pending')
      throw new Error('Only a pending runner enrollment can be revoked.');
    value.state = 'revoked';
    value.revokedAt = iso(now());
    value.revision++;
    await save();
    return publicEnrollment(value);
  }

  async function rotateIdentity(runnerId, organizationId, revision) {
    const value = runner(runnerId, organizationId);
    if (value.machineIdentity?.revision !== revision)
      throw new Error('Machine identity changed. Reload first.');
    if (value.machineIdentity.state !== 'active')
      throw new Error('Machine identity is not active.');
    const rotatedAt = now();
    const credential = machineCredential();
    const credentialDigest = digest(credential).toString('hex');
    value.machineIdentity = {
      ...value.machineIdentity,
      fingerprint: credentialDigest.slice(0, 24),
      credentialDigest,
      issuedAt: iso(rotatedAt),
      rotateAfter: iso(new Date(rotatedAt.getTime() + 24 * 60 * 60 * 1000)),
      revision: revision + 1,
    };
    value.revision++;
    await save();
    return {
      machineIdentity: publicMachineIdentity(value.machineIdentity),
      machineCredential: credential,
    };
  }

  async function revokeIdentity(runnerId, organizationId, revision) {
    const value = runner(runnerId, organizationId);
    if (value.machineIdentity?.revision !== revision)
      throw new Error('Machine identity changed. Reload first.');
    if (value.machineIdentity.state !== 'active')
      throw new Error('Machine identity is not active.');
    value.machineIdentity.state = 'revoked';
    value.machineIdentity.revokedAt = iso(now());
    value.machineIdentity.revision++;
    value.online = false;
    value.revision++;
    await save();
    return publicMachineIdentity(value.machineIdentity);
  }

  function authenticate(credential, expected = {}) {
    if (typeof credential !== 'string' || !credential.startsWith('rnr_'))
      throw new Error('Runner machine credential is invalid.');
    const presented = digest(credential);
    const value = state.runners.find((candidate) => {
      const identity = candidate.machineIdentity;
      if (!identity?.credentialDigest || identity.state !== 'active') return false;
      const stored = Buffer.from(identity.credentialDigest, 'hex');
      return stored.length === presented.length && timingSafeEqual(stored, presented);
    });
    if (
      !value ||
      (expected.organizationId && value.organizationId !== expected.organizationId) ||
      (expected.runnerId && value.id !== expected.runnerId) ||
      (expected.environmentId && value.environmentId !== expected.environmentId)
    )
      throw new Error('Runner machine credential is invalid.');
    return {
      principal: {
        kind: 'runner',
        runnerId: value.id,
        organizationId: value.organizationId,
        environmentId: value.environmentId,
        machineIdentityId: value.machineIdentity.id,
        revision: value.machineIdentity.revision,
      },
      runner: publicRunner(value),
    };
  }

  return {
    issue,
    redeem,
    revoke,
    rotateIdentity,
    revokeIdentity,
    authenticate,
    get: (id, organizationId) => publicEnrollment(enrollment(id, organizationId)),
    list: (organizationId) =>
      state.runnerEnrollments
        .filter((value) => value.organizationId === organizationId)
        .map(publicEnrollment),
  };
}
