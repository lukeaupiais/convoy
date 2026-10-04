const LIMIT_KEYS = Object.freeze([
  'maxDescendantRuns', 'maxMapItems', 'maxConcurrentChildren', 'maxDeadlineMs', 'maxActiveDescendantRuns',
  'maxActiveDescendantsPerRoot',
]);
const DEFAULTS = Object.freeze({
  maxDescendantRuns: 128,
  maxMapItems: 100,
  maxConcurrentChildren: 8,
  maxDeadlineMs: 604_800_000,
  maxActiveDescendantRuns: 32,
  maxActiveDescendantsPerRoot: 8,
});
const HARD_MAX = Object.freeze({
  maxDescendantRuns: 1000,
  maxMapItems: 100,
  maxConcurrentChildren: 32,
  maxDeadlineMs: 604_800_000,
  maxActiveDescendantRuns: 256,
  maxActiveDescendantsPerRoot: 64,
});
const clone = value => structuredClone(value);

function normalizeLimits(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== LIMIT_KEYS.length || Object.keys(value).some(key => !LIMIT_KEYS.includes(key)))
    throw new Error(`${label} must declare every composition limit.`);
  const result = {};
  for (const key of LIMIT_KEYS) {
    const limit = value[key];
    if (!Number.isInteger(limit) || limit < 1 || limit > HARD_MAX[key])
      throw new Error(`${label} ${key} must be a positive bounded integer.`);
    result[key] = limit;
  }
  return result;
}

export function createWorkflowCompositionPolicy({ state }) {
  state.workflowCompositionPolicies ??= { organizations: {}, projects: {} };
  const policies = state.workflowCompositionPolicies;
  policies.organizations ??= {};
  policies.projects ??= {};

  function projectRecord(projectId, organizationId) {
    const project = state.projects?.find(value => value.id === projectId && value.organizationId === organizationId);
    if (!project) throw new Error('Composition policy project is unavailable in this organization.');
    return project;
  }

  function resolveWorkflowCompositionLimits(organizationId, projectId) {
    if (typeof organizationId !== 'string' || !organizationId.trim()) throw new Error('Composition policy organization is required.');
    const organization = policies.organizations[organizationId] ?? { revision: 0, limits: clone(DEFAULTS) };
    if (projectId) projectRecord(projectId, organizationId);
    const projectPolicy = projectId ? policies.projects[projectId] : null;
    const project = projectPolicy?.organizationId === organizationId
      ? projectPolicy : { revision: 0, limits: null };
    const effective = Object.fromEntries(LIMIT_KEYS.map(key => [key,
      Math.min(organization.limits[key], project.limits?.[key] ?? organization.limits[key])]));
    return { organization: { revision: organization.revision, limits: clone(organization.limits) },
      project: { revision: project.revision, limits: project.limits ? clone(project.limits) : null },
      effective, digest: JSON.stringify([organizationId, organization, projectId ?? null, project]) };
  }

  function saveWorkflowCompositionLimits({ organizationId, projectId, baseRevision, limits }) {
    if (typeof organizationId !== 'string' || !organizationId.trim() || !Number.isInteger(baseRevision) || baseRevision < 0)
      throw new Error('Composition policy identity or base revision is invalid.');
    const normalized = normalizeLimits(limits, 'Composition policy');
    if (projectId) {
      projectRecord(projectId, organizationId);
      const current = policies.projects[projectId] ?? { organizationId, revision: 0, limits: null };
      if (current.organizationId !== organizationId || current.revision !== baseRevision)
        throw new Error('Project composition policy changed. Reload before saving.');
      const organization = policies.organizations[organizationId] ?? { revision: 0, limits: clone(DEFAULTS) };
      for (const key of LIMIT_KEYS) if (normalized[key] > organization.limits[key])
        throw new Error(`Project composition policy cannot exceed organization ${key}.`);
      policies.projects[projectId] = { organizationId, revision: current.revision + 1, limits: normalized };
      return clone(policies.projects[projectId]);
    }
    const current = policies.organizations[organizationId] ?? { revision: 0, limits: clone(DEFAULTS) };
    if (current.revision !== baseRevision) throw new Error('Organization composition policy changed. Reload before saving.');
    for (const project of Object.values(policies.projects)) if (project.organizationId === organizationId && project.limits) {
      for (const key of LIMIT_KEYS) if (project.limits[key] > normalized[key])
        throw new Error(`Organization ${key} cannot be reduced below an existing project policy.`);
    }
    policies.organizations[organizationId] = { revision: current.revision + 1, limits: normalized };
    return clone(policies.organizations[organizationId]);
  }

  function snapshot({ organizationId, projectIds } = {}) {
    const organizations = {};
    const projects = {};
    if (organizationId) {
      const value = policies.organizations[organizationId];
      organizations[organizationId] = value ? clone(value) : { revision: 0, limits: clone(DEFAULTS) };
    }
    const allowed = projectIds ? new Set(projectIds) : null;
    for (const [projectId, value] of Object.entries(policies.projects)) {
      if (value.organizationId === organizationId && (!allowed || allowed.has(projectId))) projects[projectId] = clone(value);
    }
    return { defaults: clone(DEFAULTS), organizations, projects };
  }

  return { resolveWorkflowCompositionLimits, saveWorkflowCompositionLimits, snapshot };
}
