import { randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);
const roles = new Set(['use', 'administer']);
const kinds = new Set(['user', 'team', 'project']);

const requiredId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`${label} is required.`);
  return value;
};

const subjectId = (subject) => subject?.[`${subject.kind}Id`];
const resourceId = (resource) =>
  resource?.kind === 'runner-pool' ? resource.runnerPoolId : resource?.environmentId;

function glob(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Resource bindings are the tenant boundary between membership and placement.
 * They deliberately know nothing about runner transports or user credentials.
 */
export function createEnvironmentAccess({ state, catalog, save }) {
  const migrating = state.environmentAccessBindings === undefined;
  state.environmentAccessBindings ??= [];

  const organizationForProject = (projectId) =>
    catalog.project(projectId).organizationId ?? 'personal';
  const environment = (id, organizationId) => {
    const value = state.environments?.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Environment not found.');
    return value;
  };
  const pool = (id, organizationId) => {
    const value = state.runnerPools?.find(
      (candidate) => candidate.id === id && candidate.organizationId === organizationId,
    );
    if (!value) throw new Error('Runner pool not found.');
    return value;
  };

  function normalizeSubject(subject, organizationId) {
    if (!subject || !kinds.has(subject.kind)) throw new Error('Unknown binding subject.');
    const id = requiredId(subjectId(subject), `${subject.kind} ID`);
    if (subject.kind === 'project' && organizationForProject(id) !== organizationId)
      throw new Error('Project not found.');
    if (
      subject.kind === 'team' &&
      !state.organizations?.teams?.some(
        (candidate) =>
          candidate.id === id &&
          candidate.organizationId === organizationId &&
          candidate.state === 'active',
      )
    )
      throw new Error('Team not found.');
    if (
      subject.kind === 'user' &&
      !state.organizations?.memberships?.some(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.principal?.kind === 'user' &&
          candidate.principal.userId === id &&
          candidate.state === 'active',
      )
    )
      throw new Error('User not found.');
    return { kind: subject.kind, [`${subject.kind}Id`]: id };
  }

  function normalizeResource(resource, organizationId) {
    if (!resource || !['environment', 'runner-pool'].includes(resource.kind))
      throw new Error('Unknown binding resource.');
    const id = requiredId(resourceId(resource), `${resource.kind} ID`);
    if (resource.kind === 'environment') environment(id, organizationId);
    else pool(id, organizationId);
    return resource.kind === 'environment'
      ? { kind: 'environment', environmentId: id }
      : { kind: 'runner-pool', runnerPoolId: id };
  }

  function normalizeConstraints(value = {}) {
    const list = (items, label) => {
      if (
        items === undefined ||
        (Array.isArray(items) &&
          items.every((item) => typeof item === 'string' && item.length <= 500))
      )
        return items ? [...new Set(items)] : [];
      throw new Error(`${label} must be a list of strings.`);
    };
    return {
      executionProfiles: list(value.executionProfiles, 'Execution profiles'),
      repositoryPatterns: list(value.repositoryPatterns, 'Repository patterns'),
      schedules: list(value.schedules, 'Schedules'),
    };
  }

  async function saveBinding(input) {
    const organizationId = requiredId(input.organizationId, 'Organization ID');
    if (!roles.has(input.role)) throw new Error('Unknown environment access role.');
    const old = input.id
      ? state.environmentAccessBindings.find(
          (candidate) => candidate.id === input.id && candidate.organizationId === organizationId,
        )
      : undefined;
    if (input.id && !old) throw new Error('Environment access binding not found.');
    if (old && old.revision !== input.revision)
      throw new Error('Environment access binding changed. Reload first.');
    const value = {
      id: old?.id ?? randomUUID(),
      organizationId,
      subject: normalizeSubject(input.subject, organizationId),
      resource: normalizeResource(input.resource, organizationId),
      role: input.role,
      constraints: normalizeConstraints(input.constraints),
      revision: (old?.revision ?? 0) + 1,
    };
    if (old) Object.assign(old, value);
    else state.environmentAccessBindings.push(value);
    await save();
    return clone(value);
  }

  function subjects(context) {
    const values = [];
    if (context.userId) values.push(`user:${context.userId}`);
    if (context.teamId) values.push(`team:${context.teamId}`);
    for (const teamId of context.teamIds ?? []) values.push(`team:${teamId}`);
    if (context.projectId) values.push(`project:${context.projectId}`);
    return new Set(values);
  }

  function authorize(context, target, requestedRole = 'use', options = {}) {
    const organizationId = context.organizationId ?? organizationForProject(context.projectId);
    if (!organizationId || target.organizationId !== organizationId)
      return { allowed: false, reason: 'Environment access binding not found.' };
    const acceptedSubjects = subjects(context);
    const resourceKeys = new Set([`environment:${target.id}`]);
    if (options.poolId) resourceKeys.add(`runner-pool:${options.poolId}`);
    const binding = state.environmentAccessBindings.find((candidate) => {
      if (candidate.organizationId !== organizationId) return false;
      const sid = `${candidate.subject.kind}:${subjectId(candidate.subject)}`;
      const rid = `${candidate.resource.kind}:${resourceId(candidate.resource)}`;
      if (!acceptedSubjects.has(sid) || !resourceKeys.has(rid)) return false;
      if (requestedRole === 'administer' && candidate.role !== 'administer') return false;
      const constraints = candidate.constraints ?? {};
      if (
        constraints.executionProfiles?.length &&
        !constraints.executionProfiles.includes(options.executionProfile)
      )
        return false;
      if (
        constraints.repositoryPatterns?.length &&
        !constraints.repositoryPatterns.some((pattern) => glob(pattern, options.repository ?? ''))
      )
        return false;
      // Schedule interpretation belongs to organization policy. Until injected,
      // a scheduled binding cannot silently widen access.
      if (constraints.schedules?.length && options.scheduleAuthorized !== true) return false;
      return true;
    });
    return binding
      ? { allowed: true, binding: clone(binding) }
      : { allowed: false, reason: 'Environment access binding not found.' };
  }

  function migrateProjectBinding(organizationId, projectId, environmentId, legacyPersonal = false) {
    if (!migrating && !legacyPersonal) return;
    if (
      state.environmentAccessBindings.some(
        (value) =>
          value.organizationId === organizationId &&
          value.subject.kind === 'project' &&
          value.subject.projectId === projectId &&
          value.resource.kind === 'environment' &&
          value.resource.environmentId === environmentId,
      )
    )
      return;
    state.environmentAccessBindings.push({
      id: randomUUID(),
      organizationId,
      subject: { kind: 'project', projectId },
      resource: { kind: 'environment', environmentId },
      role: 'use',
      constraints: { executionProfiles: [], repositoryPatterns: [], schedules: [] },
      revision: 1,
    });
  }

  return {
    saveBinding,
    authorize,
    migrateProjectBinding,
    bindings: () => state.environmentAccessBindings.map(clone),
  };
}
