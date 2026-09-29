import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((k) => allowed.includes(k));

export function normalizeRuntimeSelection(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    !keys(value, ['id', 'version', 'required']) ||
    !id(value.id) ||
    !integer(value.version, 1, 1000000) ||
    typeof value.required !== 'boolean'
  )
    throw new Error('Runtime selection requires id, version and required. Use null to disable.');
  return structuredClone(value);
}

export function normalizeRuntimeDefinition(value) {
  if (
    !keys(value, [
      'id',
      'name',
      'image',
      'sourceCommit',
      'startup',
      'readiness',
      'guidance',
      'fixtureDigest',
      'limits',
    ]) ||
    !id(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 100 ||
    !/^sha256:[a-f0-9]{64}$/.test(value.image ?? '') ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.fixtureDigest ?? '') ||
    typeof value.guidance !== 'string' ||
    value.guidance.length > 4000
  )
    throw new Error('Invalid runtime definition. Pin local image, source and fixture digests.');
  for (const key of ['startup', 'readiness']) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 24 ||
      (key === 'readiness' && !value[key].length) ||
      value[key].some(
        (arg) => typeof arg !== 'string' || !arg || arg.length > 1000 || arg.includes('\0'),
      )
    )
      throw new Error('Runtime entrypoints must be bounded argv arrays.');
  }
  const l = value.limits;
  if (
    !keys(l, [
      'memoryMb',
      'scratchMb',
      'sharedMemoryMb',
      'cpus',
      'pids',
      'lifetimeSeconds',
      'startupSeconds',
      'commandSeconds',
    ]) ||
    !integer(l.memoryMb, 64, 8192) ||
    !integer(l.scratchMb, 16, 4096) ||
    l.scratchMb > l.memoryMb ||
    (l.sharedMemoryMb !== undefined &&
      (!integer(l.sharedMemoryMb, 1, 1024) || l.sharedMemoryMb > l.memoryMb)) ||
    typeof l.cpus !== 'number' ||
    !Number.isFinite(l.cpus) ||
    l.cpus < 0.1 ||
    l.cpus > 4 ||
    !integer(l.pids, 16, 512) ||
    !integer(l.lifetimeSeconds, 30, 3600) ||
    !integer(l.startupSeconds, 1, 300) ||
    !integer(l.commandSeconds, 1, 900) ||
    l.startupSeconds + l.commandSeconds > l.lifetimeSeconds
  )
    throw new Error('Invalid runtime limits or insufficient lifetime.');
  return structuredClone(value);
}

/** Execution owns publication and selection. Runtime commands remain generic. */
export function createVerificationRuntimes({ state, catalog, save }) {
  state.runtimeDefinitions ??= [];
  return {
    publish: async (command) => {
      const project = catalog.project(command.projectId);
      if (!project || (command.organizationId && project.organizationId !== command.organizationId))
        throw new Error('Project not found.');
      const definition = normalizeRuntimeDefinition(command.definition);
      const revisions = state.runtimeDefinitions.filter(
        (d) => d.projectId === project.id && d.id === definition.id,
      );
      const version = Math.max(0, ...revisions.map((d) => d.version));
      if (command.baseVersion !== version)
        throw new Error('Runtime definition changed. Reload first.');
      const published = {
        ...definition,
        projectId: project.id,
        organizationId: project.organizationId,
        version: version + 1,
        publishedAt: new Date().toISOString(),
      };
      published.digest = hash(published);
      state.runtimeDefinitions.push(published);
      await save();
      return structuredClone(published);
    },
    resolve(projectId, selection) {
      const ref = normalizeRuntimeSelection(selection);
      if (!ref) return null;
      const definition = state.runtimeDefinitions.find(
        (d) => d.projectId === projectId && d.id === ref.id && d.version === ref.version,
      );
      if (!definition) throw new Error('Runtime definition not found in this project.');
      return { definition: structuredClone(definition), required: ref.required };
    },
    snapshot(projectId) {
      return state.runtimeDefinitions
        .filter((d) => !projectId || d.projectId === projectId)
        .map((d) => structuredClone(d));
    },
  };
}
