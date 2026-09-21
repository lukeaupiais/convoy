import { createHash } from 'node:crypto';

const clone = (value) => structuredClone(value);
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 240)
    throw new Error(`${label} is required.`);
  return value;
};
const count = (value, label) => {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a positive integer.`);
  return value;
};
const positive = (value, label) => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be at least one.`);
  return value;
};
const demandId = (key) => `capacity-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

export function staticCapacityProvider(input = {}) {
  const authorityCeiling = input.authorityCeiling ?? 'trusted';
  if (!['contained', 'trusted'].includes(authorityCeiling))
    throw new Error('Unknown capacity authority ceiling.');
  return {
    kind: 'static',
    adapterId: text(input.adapterId ?? 'static', 'Capacity adapter ID'),
    runtimeRevision: text(input.runtimeRevision ?? 'unmanaged-runtime-v1', 'Runtime revision'),
    imageRevision: text(input.imageRevision ?? 'unmanaged-image-v1', 'Image revision'),
    authorityCeiling,
    budgetCeiling: {
      maxRunners: positive(input.budgetCeiling?.maxRunners ?? 1, 'Runner budget'),
      maxConcurrent: positive(input.budgetCeiling?.maxConcurrent ?? 4, 'Concurrency budget'),
      ...(input.budgetCeiling?.maxHourlyCost === undefined
        ? {}
        : { maxHourlyCost: input.budgetCeiling.maxHourlyCost }),
      ...(input.budgetCeiling?.currency ? { currency: input.budgetCeiling.currency } : {}),
    },
    revision: input.revision ?? 1,
  };
}

export function createStaticCapacityAdapter() {
  return {
    id: 'static',
    kind: 'static',
    async observe(input) {
      return {
        availableCapacity: input.availableCapacity,
        drainState: input.drainState,
      };
    },
  };
}

/**
 * Capacity owns durable demand evidence. Its adapter can only observe capacity:
 * provisioning, scaling, draining and destruction are intentionally absent.
 */
export function createCapacity({ state, save, provider = createStaticCapacityAdapter(), now }) {
  state.capacityRequests ??= [];
  if (!provider || provider.kind !== 'static' || typeof provider.observe !== 'function')
    throw new Error('A read-only static capacity provider is required.');

  const clock = now ?? (() => new Date().toISOString());

  async function recordDemand(input) {
    const demandKey = text(input.demandKey, 'Capacity demand key');
    const organizationId = text(input.organizationId, 'Organization ID');
    const projectId = text(input.projectId, 'Project ID');
    const project = state.projects?.find(
      (value) => value.id === projectId && value.organizationId === organizationId,
    );
    if (!project) throw new Error('Capacity project not found.');
    if (
      input.poolId &&
      !state.runnerPools?.some(
        (value) => value.id === input.poolId && value.organizationId === organizationId,
      )
    )
      throw new Error('Capacity pool not found.');
    const environmentIds = [...new Set(input.environmentIds ?? [])].sort();
    if (
      !environmentIds.length ||
      environmentIds.some(
        (id) =>
          !state.environments?.some(
            (value) => value.id === id && value.organizationId === organizationId,
          ),
      )
    )
      throw new Error('Capacity environment not found.');
    const desiredCapacity = positive(input.desiredCapacity, 'Desired capacity');
    const configuredAvailable = count(input.availableCapacity, 'Available capacity');
    const configuration = staticCapacityProvider(input.configuration);
    if (configuration.adapterId !== provider.id)
      throw new Error('Capacity adapter does not match the immutable provider configuration.');
    const existing = state.capacityRequests.find((value) => value.demandKey === demandKey);
    const immutable = {
      organizationId,
      projectId,
      poolId: input.poolId,
      environmentIds,
      providerKind: 'static',
      providerAdapterId: configuration.adapterId,
      runtimeRevision: configuration.runtimeRevision,
      imageRevision: configuration.imageRevision,
      authorityCeiling: configuration.authorityCeiling,
      budgetCeiling: clone(configuration.budgetCeiling),
    };
    if (existing) {
      for (const field of [
        'organizationId',
        'projectId',
        'poolId',
        'providerKind',
        'providerAdapterId',
        'runtimeRevision',
        'imageRevision',
        'authorityCeiling',
      ])
        if (existing[field] !== immutable[field])
          throw new Error('Capacity demand constraints changed; create a new demand key.');
      if (JSON.stringify(existing.environmentIds) !== JSON.stringify(immutable.environmentIds))
        throw new Error('Capacity demand environments changed; create a new demand key.');
      if (JSON.stringify(existing.budgetCeiling) !== JSON.stringify(immutable.budgetCeiling))
        throw new Error('Capacity demand budget changed; create a new demand key.');
      if (
        existing.state === 'open' &&
        existing.desiredCapacity === desiredCapacity &&
        existing.availableCapacity === configuredAvailable
      )
        return clone(existing);
    }
    const observation = await provider.observe({
      demandKey,
      organizationId,
      projectId,
      poolId: input.poolId,
      environmentIds,
      desiredCapacity,
      availableCapacity: configuredAvailable,
      drainState: input.drainState ?? 'active',
      configuration: clone(configuration),
    });
    const availableCapacity = count(observation.availableCapacity, 'Available capacity');
    const drainState = observation.drainState ?? input.drainState ?? 'active';
    if (!['active', 'draining', 'drained'].includes(drainState))
      throw new Error('Unknown capacity drain state.');
    const at = clock();
    const exhausted = availableCapacity < desiredCapacity;
    const value = {
      id: existing?.id ?? demandId(demandKey),
      demandKey,
      ...immutable,
      desiredCapacity,
      availableCapacity,
      drainState,
      state: exhausted ? 'open' : 'satisfied',
      ...(exhausted ? { reason: 'exhausted' } : {}),
      createdAt: existing?.createdAt ?? at,
      observedAt: at,
      ...(exhausted ? {} : { satisfiedAt: existing?.satisfiedAt ?? at }),
      revision: (existing?.revision ?? 0) + 1,
    };
    if (existing) {
      Object.assign(existing, value);
      if (!exhausted) delete existing.reason;
    } else state.capacityRequests.push(value);
    await save();
    return clone(value);
  }

  function requests() {
    return state.capacityRequests.map(clone);
  }

  async function satisfy(demandKey, availableCapacity = 1) {
    const existing = state.capacityRequests.find(
      (value) => value.demandKey === demandKey && value.state === 'open',
    );
    if (!existing) return undefined;
    return recordDemand({
      demandKey,
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      poolId: existing.poolId,
      environmentIds: existing.environmentIds,
      desiredCapacity: existing.desiredCapacity,
      availableCapacity,
      drainState: 'active',
      configuration: {
        kind: 'static',
        adapterId: existing.providerAdapterId,
        runtimeRevision: existing.runtimeRevision,
        imageRevision: existing.imageRevision,
        authorityCeiling: existing.authorityCeiling,
        budgetCeiling: existing.budgetCeiling,
        revision: 1,
      },
    });
  }

  function statuses() {
    const groups = new Map();
    for (const request of state.capacityRequests) {
      const key = `${request.organizationId}:${request.poolId ?? ''}`;
      const current = groups.get(key) ?? {
        organizationId: request.organizationId,
        ...(request.poolId ? { poolId: request.poolId } : {}),
        desiredCapacity: 0,
        availableCapacity: 0,
        openRequests: 0,
        drainState: 'active',
        observedAt: request.observedAt,
      };
      if (request.state === 'open') {
        current.desiredCapacity += request.desiredCapacity;
        current.openRequests += 1;
      }
      if (request.observedAt >= current.observedAt)
        current.availableCapacity = request.availableCapacity;
      if (request.drainState !== 'active') current.drainState = request.drainState;
      if (request.observedAt > current.observedAt) current.observedAt = request.observedAt;
      groups.set(key, current);
    }
    return [...groups.values()].map(clone);
  }

  return { providerId: provider.id, recordDemand, satisfy, requests, statuses };
}
