import { randomUUID } from 'node:crypto';
import { requiredText as text } from '../../shared/validation.mjs';
import { executionProfile } from './policy.mjs';
import { staticCapacityProvider } from './capacity.mjs';
const integer = (v, label, max = 32) => {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${label} must be 1–${max}.`);
  return v;
};
const list = (v = []) => {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 100)
  )
    throw new Error('Expected a list of names/IDs.');
  return [...new Set(v)];
};
const accessMode = (value = 'contained') => {
  if (!['contained', 'trusted'].includes(value)) throw new Error('Unknown runner access mode.');
  return value;
};
export function createPlacement({
  state,
  save,
  catalog,
  workExecution,
  execute,
  event,
  policy: executionPolicy,
  access,
  capacity,
  audit = async () => {},
  authorizeFullSystem = async () => ({ effect: 'allow' }),
}) {
  state.environments ??= [];
  state.runnerPools ??= [];
  state.scheduler ??= { maxConcurrent: 4 };
  state.schedulers ??= { personal: structuredClone(state.scheduler) };
  state.schedulers.personal ??= structuredClone(state.scheduler);
  const capacityConfiguration = (maxConcurrent = 4, previous) =>
    staticCapacityProvider({
      ...previous,
      adapterId: previous?.adapterId ?? capacity.providerId,
      budgetCeiling: {
        maxRunners: previous?.budgetCeiling?.maxRunners ?? 1,
        ...(previous?.budgetCeiling ?? {}),
        maxConcurrent,
      },
    });
  const defaultOrganizationId = () => {
    const organizations = Array.isArray(state.organizations)
      ? state.organizations
      : state.organizations?.organizations;
    return (
      organizations?.find((value) => value.kind === 'personal')?.id ??
      state.projects.find((value) => value.organizationId)?.organizationId ??
      'personal'
    );
  };
  const projectOrganizationId = (projectId) =>
    catalog.project(projectId).organizationId ?? defaultOrganizationId();
  const auditDispatch = (session, input) => {
    const projectId = session.projectId ?? catalog.ticket(session.id)?.projectId;
    return audit({
      organizationId: session.organizationId ?? projectOrganizationId(projectId),
      actor: session.executionPrincipal ?? { kind: 'user', userId: 'local' },
      context: { projectId, sessionId: String(session.id) },
      action: 'runner.dispatch',
      resource: { kind: 'assignment' },
      ...input,
    });
  };
  const migratePersonalAccess =
    state.environmentAccessBindings.length === 0 &&
    state.projects.every(
      (project) => (project.organizationId ?? defaultOrganizationId()) === 'personal',
    );
  const attested = (runner, capabilities) => ({
    ...capabilities,
    enforcement: {
      isolation: runner.accessMode === 'trusted' ? ['workspace', 'host'] : ['workspace'],
      network: runner.accessMode === 'trusted' ? ['none', 'host'] : ['none'],
      failClosed: true,
      platform: capabilities.platform ?? capabilities.worker?.platform,
      architecture: capabilities.arch ?? capabilities.worker?.arch,
    },
  });
  for (const environment of state.environments)
    environment.capacityProvider = capacityConfiguration(
      environment.maxConcurrent,
      environment.capacityProvider,
    );
  for (const r of state.runners) {
    const organizationId =
      r.organizationId ??
      r.projectIds?.map(projectOrganizationId).find(Boolean) ??
      defaultOrganizationId();
    if (!r.environmentId) {
      let e = state.environments.find(
        (e) =>
          e.kind === r.kind &&
          e.host === r.host &&
          (!e.organizationId || e.organizationId === organizationId),
      );
      if (!e) {
        e = {
          id: randomUUID(),
          organizationId,
          name: r.kind === 'local' ? 'Local machine' : r.host,
          kind: r.kind,
          host: r.host,
          enabled: true,
          maxConcurrent: 4,
          tags: [],
          capacityProvider: capacityConfiguration(4),
          revision: 1,
        };
        state.environments.push(e);
      }
      r.environmentId = e.id;
    }
    const runnerEnvironment = state.environments.find((entry) => entry.id === r.environmentId);
    if (runnerEnvironment) {
      runnerEnvironment.organizationId ??= organizationId;
      r.organizationId ??= runnerEnvironment.organizationId;
    }
    if (runnerEnvironment)
      runnerEnvironment.capacityProvider = capacityConfiguration(
        runnerEnvironment.maxConcurrent,
        runnerEnvironment.capacityProvider,
      );
    r.enabled ??= true;
    r.lifecycle ??= 'persistent';
    r.registration ??= 'managed';
    r.draining ??= false;
    r.maxConcurrent ??= 4;
    r.projectIds ??= state.projects.map((p) => p.id);
    r.projectIds = r.projectIds.filter(
      (projectId) => projectOrganizationId(projectId) === r.organizationId,
    );
    for (const projectId of r.projectIds)
      access.migrateProjectBinding(
        r.organizationId,
        projectId,
        r.environmentId,
        migratePersonalAccess && r.organizationId === 'personal',
      );
    r.tags ??= [];
    r.revision ??= 1;
    r.accessMode = accessMode(r.accessMode);
    if (r.capabilities) r.capabilities = attested(r, r.capabilities);
  }
  for (const p of state.runnerPools) {
    p.organizationId ??=
      state.runners.find((runner) => p.runnerIds.includes(runner.id))?.organizationId ??
      defaultOrganizationId();
  }
  for (const session of Object.values(state.sessions)) {
    if (!session.workspace || !session.runnerId || session.executionGrant) continue;
    const assigned = state.runners.find((runner) => runner.id === session.runnerId);
    if (!assigned) continue;
    session.executionProfile ??= assigned.accessMode === 'trusted' ? 'full-access-ask' : 'ask';
    session.executionGrant = executionPolicy.resolve(session, assigned);
    if (session.assignment) session.assignment.policyDigest = session.executionGrant.digest;
  }
  for (const s of Object.values(state.sessions))
    if (
      ['reserved', 'running'].includes(s.assignment?.state) ||
      (s.runnerId && ['running', 'waiting_approval', 'waiting_question'].includes(s.status))
    )
      s.assignment = {
        ...s.assignment,
        token: s.assignment?.token ?? randomUUID(),
        runnerId: s.assignment?.runnerId ?? s.runnerId,
        environmentId:
          s.assignment?.environmentId ??
          state.runners.find((r) => r.id === s.runnerId)?.environmentId,
        state: 'uncertain',
        message:
          'Daemon restarted before assignment release. Inspect the original environment before reconciling.',
      };
  const env = (id) => {
    const e = state.environments.find((e) => e.id === id);
    if (!e) throw new Error('Environment not found.');
    return e;
  };
  const runner = (id) => {
    const r = state.runners.find((r) => r.id === id);
    if (!r) throw new Error('Runner not found.');
    return r;
  };
  const pool = (id) => {
    const p = state.runnerPools.find((p) => p.id === id);
    if (!p) throw new Error('Runner pool not found.');
    return p;
  };
  const load = (id, environment = false) =>
    Object.values(state.sessions).filter(
      (s) =>
        ['reserved', 'running', 'uncertain'].includes(s.assignment?.state) &&
        s.assignment[environment ? 'environmentId' : 'runnerId'] === id,
    ).length;
  const backgroundLoad = (id, environment = false) =>
    Object.values(state.sessions).reduce(
      (count, s) =>
        count +
        ((environment
          ? state.runners.find((r) => r.id === s.runnerId)?.environmentId
          : s.runnerId) === id
          ? (s.commands ?? []).filter((c) => ['running', 'stopping'].includes(c.state)).length +
            (s.terminals ?? []).filter((t) => t.state === 'running').length
          : 0),
      0,
    );
  function policy(input, inherit = true) {
    if (!input || !['none', 'pinned', 'pool', ...(inherit ? ['inherit'] : [])].includes(input.mode))
      throw new Error('Choose text-only, a pinned runner, or a runner pool.');
    const p = {
      mode: input.mode,
      requiredTools: list(input.requiredTools),
      requiredTags: list(input.requiredTags),
      preferEnvironmentIds: list(input.preferEnvironmentIds),
      strategy: input.strategy ?? 'least-loaded',
    };
    if (!['least-loaded', 'priority'].includes(p.strategy))
      throw new Error('Unknown placement strategy.');
    if (
      p.requiredTools.some(
        (t) =>
          ![
            'read_file',
            'list_files',
            'search_files',
            'inspect_repository',
            'write_file',
            'apply_patch',
            'shell',
            'start_command',
            'command_status',
            'read_command_output',
            'send_command_input',
            'stop_command',
          ].includes(t),
      )
    )
      throw new Error('Unknown required tool.');
    p.preferEnvironmentIds.forEach(env);
    if (p.mode === 'pinned') p.runnerId = runner(input.runnerId).id;
    if (p.mode === 'pool') p.poolId = pool(input.poolId).id;
    return p;
  }
  function effective(s) {
    const t = catalog.ticket(s.activeTicketId === undefined ? s.id : s.activeTicketId);
    const value = s.placement ?? t?.placement ?? { mode: 'none' };
    return value.mode === 'inherit'
      ? catalog.project(t?.projectId ?? s.projectId ?? state.projects[0].id).placement
      : value;
  }
  function choose(s, requiredTools = []) {
    if (s.assignment?.state === 'uncertain')
      return {
        reason:
          s.assignment.message ??
          'Previous execution is uncertain. Reconcile it on the original runner.',
      };
    const p = effective(s);
    const bound = !!(s.workspace || s.workspaceRequest);
    const projectId = s.projectId ?? catalog.ticket(s.id)?.projectId;
    const organizationId = s.organizationId ?? projectOrganizationId(projectId);
    if (!bound && p.mode === 'none') return { textOnly: true };
    const allowed = bound
      ? [s.runnerId]
      : p.mode === 'pinned'
        ? [p.runnerId]
        : p.mode === 'pool'
          ? pool(p.poolId).runnerIds
          : [];
    const required = [...new Set([...(p.requiredTools ?? []), ...requiredTools])];
    const preference = p.preferEnvironmentIds ?? [];
    let accessDenied = false;
    const eligible = allowed
      .map((id) => state.runners.find((r) => r.id === id))
      .filter(Boolean)
      .filter((r) => {
        const e = env(r.environmentId);
        const tags = [...e.tags, ...r.tags];
        const authorized = access.authorize({ ...s, organizationId, projectId }, e, 'use', {
          poolId: p.mode === 'pool' ? p.poolId : undefined,
          executionProfile: executionPolicy.selected(s),
          repository: r.repository,
        }).allowed;
        if (!authorized) accessDenied = true;
        return (
          authorized &&
          r.organizationId === organizationId &&
          e.enabled &&
          r.enabled &&
          r.online &&
          executionPolicy.supports(r, executionPolicy.selected(s)) &&
          r.projectIds.includes(projectId) &&
          required.every((t) => r.capabilities.tools.includes(t)) &&
          (p.requiredTags ?? []).every((t) => tags.includes(t))
        );
      });
    const candidates = eligible.filter(
      (r) =>
        !r.draining &&
        load(r.id) < r.maxConcurrent &&
        load(r.environmentId, true) < env(r.environmentId).maxConcurrent,
    );
    candidates.sort((a, b) => {
      const pref = (r) => {
        const i = preference.indexOf(r.environmentId);
        return i < 0 ? preference.length : i;
      };
      return (
        pref(a) - pref(b) ||
        (p.strategy === 'priority'
          ? allowed.indexOf(a.id) - allowed.indexOf(b.id)
          : load(a.id) / a.maxConcurrent - load(b.id) / b.maxConcurrent ||
            load(a.environmentId, true) / env(a.environmentId).maxConcurrent -
              load(b.environmentId, true) / env(b.environmentId).maxConcurrent ||
            (a.lastAssignedAt ?? '').localeCompare(b.lastAssignedAt ?? '') ||
            allowed.indexOf(a.id) - allowed.indexOf(b.id))
      );
    });
    if (candidates.length) return { runner: candidates[0] };
    if (eligible.length) {
      const environmentIds = [...new Set(eligible.map((value) => value.environmentId))].sort();
      return {
        reason: bound
          ? 'Original runner unavailable, restricted or at capacity. Existing work cannot be rerouted.'
          : 'No eligible runner currently has capacity. Check pool membership, health, project access, tags and tools.',
        capacityDemand: {
          demandKey: `session:${s.id}:assignment`,
          organizationId,
          projectId,
          ...(p.mode === 'pool' ? { poolId: p.poolId } : {}),
          environmentIds,
          desiredCapacity: 1,
          availableCapacity: 0,
          drainState: eligible.every((value) => value.draining) ? 'drained' : 'active',
          configuration: env(environmentIds[0]).capacityProvider,
        },
      };
    }
    return {
      reason: accessDenied
        ? 'No organization-scoped environment access binding authorizes this placement.'
        : bound
          ? 'Original runner unavailable, restricted or at capacity. Existing work cannot be rerouted.'
          : 'No eligible runner currently has capacity. Check pool membership, health, project access, tags and tools.',
    };
  }
  return {
    env,
    runner,
    policy,
    effective,
    choose,
    async command(c) {
      if (c.action === 'connectRemote') {
        const host = text(c.host, 'SSH alias', 120);
        const repository = text(c.repository, 'Repository', 1000);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(host))
          throw new Error('Use an SSH config alias or user@host.');
        const projectIds = list(c.projectIds);
        if (!projectIds.length) throw new Error('Choose at least one project.');
        projectIds.forEach(catalog.project);
        const organizationId = c.organizationId ?? projectOrganizationId(projectIds[0]);
        if (projectIds.some((projectId) => projectOrganizationId(projectId) !== organizationId))
          throw new Error('Project not found.');
        const existing = state.runners.find(
          (value) =>
            value.kind === 'ssh' &&
            value.host === host &&
            value.repository === repository &&
            value.organizationId === organizationId,
        );
        if (existing) return { runnerId: existing.id, existing: true };
        let environment = state.environments.find(
          (value) =>
            value.kind === 'ssh' && value.host === host && value.organizationId === organizationId,
        );
        if (!environment) {
          environment = {
            id: randomUUID(),
            organizationId,
            name: host,
            kind: 'ssh',
            host,
            enabled: true,
            maxConcurrent: 4,
            tags: [],
            capacityProvider: capacityConfiguration(4),
            revision: 1,
          };
          state.environments.push(environment);
        }
        const candidate = {
          id: randomUUID(),
          organizationId,
          name: host,
          environmentId: environment.id,
          kind: 'ssh',
          host,
          repository,
          projectIds,
          enabled: true,
          lifecycle: 'persistent',
          registration: 'managed',
          draining: false,
          tags: [],
          maxConcurrent: 4,
          revision: 1,
          accessMode: 'contained',
        };
        const capabilities = attested(
          candidate,
          await execute(candidate, { action: 'probe', repository }),
        );
        state.runners.push({
          ...candidate,
          repository: capabilities.repository,
          capabilities,
          checkedAt: new Date().toISOString(),
          online: true,
        });
        for (const projectId of projectIds)
          access.migrateProjectBinding(
            organizationId,
            projectId,
            environment.id,
            c.organizationId === undefined && organizationId === 'personal',
          );
        await save();
        return { runnerId: candidate.id };
      }
      if (c.action === 'registerRunner') {
        let environment;
        if (c.environmentId) environment = env(c.environmentId);
        else {
          if (!['local', 'ssh'].includes(c.kind))
            throw new Error('Only local and SSH runners are implemented.');
          const host = c.kind === 'ssh' ? text(c.host, 'SSH alias', 120) : '';
          environment = {
            id: randomUUID(),
            organizationId: c.organizationId ?? defaultOrganizationId(),
            name: c.kind === 'local' ? 'Local machine' : host,
            kind: c.kind,
            host,
            enabled: true,
            maxConcurrent: 4,
            tags: [],
            capacityProvider: capacityConfiguration(4),
            revision: 1,
          };
          state.environments.push(environment);
        }
        const organizationId = c.organizationId ?? environment.organizationId;
        if (environment.organizationId !== organizationId)
          throw new Error('Environment not found.');
        const projectIds =
          c.projectIds === undefined
            ? state.projects
                .filter(
                  (project) =>
                    (project.organizationId ?? defaultOrganizationId()) === organizationId,
                )
                .map((project) => project.id)
            : list(c.projectIds);
        projectIds.forEach(catalog.project);
        if (projectIds.some((projectId) => projectOrganizationId(projectId) !== organizationId))
          throw new Error('Project not found.');
        const value = {
          id: randomUUID(),
          organizationId,
          name: text(c.name, 'Runner name', 80),
          environmentId: environment.id,
          kind: environment.kind,
          host: environment.host,
          repository: text(c.repository, 'Repository', 1000),
          projectIds,
          enabled: true,
          lifecycle: 'persistent',
          registration: 'managed',
          draining: false,
          tags: [],
          maxConcurrent: 4,
          revision: 1,
          accessMode: accessMode(c.accessMode),
        };
        const capabilities = attested(
          value,
          await execute(value, { action: 'probe', repository: value.repository }),
        );
        state.runners.push({
          ...value,
          repository: capabilities.repository,
          capabilities,
          checkedAt: new Date().toISOString(),
          online: true,
        });
        for (const projectId of projectIds)
          access.migrateProjectBinding(
            organizationId,
            projectId,
            environment.id,
            c.organizationId === undefined && organizationId === 'personal',
          );
        await save();
        return value;
      }
      if (c.action === 'probeRunner') {
        const value = runner(c.runnerId);
        try {
          value.capabilities = attested(
            value,
            await execute(value, { action: 'probe', repository: value.repository }),
          );
          value.online = true;
        } catch {
          value.online = false;
        }
        value.checkedAt = new Date().toISOString();
        await save();
        return value;
      }
      if (c.action === 'saveEnvironment') {
        const old = c.id ? env(c.id) : null;
        if (old && c.organizationId && old.organizationId !== c.organizationId)
          throw new Error('Environment not found.');
        if (old && old.revision !== c.revision)
          throw new Error('Environment changed. Reload first.');
        if (!['local', 'ssh'].includes(c.kind))
          throw new Error('Only local and SSH environments are implemented.');
        const host = c.kind === 'ssh' ? text(c.host, 'SSH alias', 120) : '';
        if (host && !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(host))
          throw new Error('Use an SSH config alias or user@host.');
        if (
          old &&
          state.runners.some((r) => r.environmentId === old.id) &&
          (host !== old.host || c.kind !== old.kind)
        )
          throw new Error(
            'An environment with runners cannot change transport. Create another environment.',
          );
        const value = {
          id: old?.id ?? randomUUID(),
          organizationId: old?.organizationId ?? c.organizationId ?? defaultOrganizationId(),
          name: text(c.name, 'Environment name', 100),
          kind: c.kind,
          host,
          enabled: c.enabled !== false,
          maxConcurrent: integer(c.maxConcurrent ?? 4, 'Environment capacity'),
          tags: list(c.tags),
          capacityProvider: capacityConfiguration(
            integer(c.maxConcurrent ?? 4, 'Environment capacity'),
            old?.capacityProvider,
          ),
          revision: (old?.revision ?? 0) + 1,
        };
        if (old) Object.assign(old, value);
        else state.environments.push(value);
        await save();
        return value;
      }
      if (c.action === 'saveRunnerPool') {
        const old = c.id ? pool(c.id) : null;
        if (old && c.organizationId && old.organizationId !== c.organizationId)
          throw new Error('Runner pool not found.');
        if (old && old.revision !== c.revision) throw new Error('Pool changed. Reload first.');
        const runnerIds = list(c.runnerIds);
        runnerIds.forEach(runner);
        const organizationId =
          old?.organizationId ??
          c.organizationId ??
          state.runners.find((value) => runnerIds.includes(value.id))?.organizationId ??
          defaultOrganizationId();
        if (runnerIds.some((runnerId) => runner(runnerId).organizationId !== organizationId))
          throw new Error('Runner not found.');
        const value = {
          id: old?.id ?? randomUUID(),
          organizationId,
          name: text(c.name, 'Pool name', 100),
          runnerIds,
          revision: (old?.revision ?? 0) + 1,
        };
        if (old) Object.assign(old, value);
        else state.runnerPools.push(value);
        await save();
        return value;
      }
      if (c.action === 'updateRunner') {
        const r = runner(c.runnerId);
        if (c.organizationId && r.organizationId !== c.organizationId)
          throw new Error('Runner not found.');
        if (c.revision !== r.revision) throw new Error('Runner changed. Reload first.');
        const projectIds = list(c.projectIds);
        projectIds.forEach(catalog.project);
        if (projectIds.some((projectId) => projectOrganizationId(projectId) !== r.organizationId))
          throw new Error('Project not found.');
        const nextAccessMode = accessMode(c.accessMode ?? r.accessMode);
        const accessChanged = nextAccessMode !== r.accessMode;
        Object.assign(r, {
          name: text(c.name, 'Runner name', 100),
          maxConcurrent: integer(c.maxConcurrent, 'Runner capacity'),
          enabled: c.enabled !== false,
          tags: list(c.tags),
          projectIds,
          accessMode: nextAccessMode,
          draining: c.draining === true,
          revision: r.revision + 1,
        });
        if (accessChanged) {
          try {
            r.capabilities = attested(
              r,
              await execute(r, { action: 'probe', repository: r.repository }),
            );
            r.online = true;
          } catch {
            r.online = false;
          }
          r.checkedAt = new Date().toISOString();
        }
        await save();
        return r;
      }
      if (c.action === 'setPlacement') {
        const target = c.taskId ? catalog.ticket(c.taskId) : catalog.project(c.projectId);
        if (!target) throw new Error('Ticket not found.');
        if (target.revision !== c.revision)
          throw new Error('Placement changed in another client. Reload first.');
        if (c.taskId) {
          catalog.assertEditable(target, true);
          if (workExecution.hasFixedWork(target))
            throw new Error(
              'Existing or uncertain work is pinned. Live workspace migration is not implemented.',
            );
        }
        target.placement = policy(c.placement, !!c.taskId);
        target.revision++;
        if (c.taskId) workExecution.clearPlacement(target);
        await save();
        return target;
      }
      if (c.action === 'setExecutionProfile') {
        const target = c.taskId ? catalog.ticket(c.taskId) : catalog.project(c.projectId);
        if (!target) throw new Error('Ticket not found.');
        if (target.revision !== c.revision)
          throw new Error('Execution profile changed in another client. Reload first.');
        if (c.taskId) {
          catalog.assertEditable(target, true);
          if (workExecution.hasFixedWork(target))
            throw new Error(
              'Existing or uncertain work has a pinned execution grant. Start or delegate new work instead.',
            );
        }
        target.executionProfile = executionProfile(c.profile, !!c.taskId);
        target.revision++;
        await save();
        return target;
      }
      if (c.action === 'setScheduler') {
        const organizationId = c.organizationId ?? 'personal';
        state.schedulers[organizationId] = {
          maxConcurrent: integer(c.maxConcurrent, 'Organization concurrency'),
        };
        if (organizationId === 'personal') state.scheduler = state.schedulers.personal;
        await save();
        return state.schedulers[organizationId];
      }
      throw new Error('Unknown placement command.');
    },
    async prepare(s, requiredTools = [], signal) {
      const selectedProfile = executionPolicy.selected(s);
      if (selectedProfile === 'full-access' || selectedProfile === 'full-access-ask') {
        const policyDecision = await authorizeFullSystem(s, selectedProfile);
        if (policyDecision.effect !== 'allow') {
          await auditDispatch(s, {
            decision: 'deny',
            outcome: 'denied',
            observations: { failureClass: 'organization-policy' },
          });
          return { reason: 'Organization policy does not permit full system access.' };
        }
      }
      s.placement ??= structuredClone(effective(s));
      const chosen = choose(s, requiredTools);
      if (chosen.capacityDemand) await capacity.recordDemand(chosen.capacityDemand);
      if (chosen.reason) {
        await auditDispatch(s, {
          decision: 'deny',
          outcome: 'denied',
          observations: { failureClass: 'runner-ineligible' },
        });
        return chosen;
      }
      if (chosen.textOnly) return chosen;
      await capacity.satisfy(`session:${s.id}:assignment`);
      const r = chosen.runner;
      const grant = executionPolicy.resolve(s, r);
      s.assignment = {
        token: randomUUID(),
        runnerId: r.id,
        environmentId: r.environmentId,
        state: 'reserved',
        at: new Date().toISOString(),
        policyDigest: grant.digest,
      };
      s.executionGrant = grant;
      r.lastAssignedAt = s.assignment.at;
      await save();
      await auditDispatch(s, {
        decision: 'allow',
        outcome: 'reserved',
        revisions: {
          profileRevision: String(grant.profileRevision),
          executionGrantDigest: grant.digest,
        },
        execution: {
          environmentId: r.environmentId,
          runnerId: r.id,
          profileId: grant.profileId,
        },
      });
      try {
        if (!r.checkedAt || Date.now() - Date.parse(r.checkedAt) > 60000) {
          r.capabilities = attested(
            r,
            await execute(r, { action: 'probe', repository: r.repository }, signal),
          );
          r.online = true;
          r.checkedAt = new Date().toISOString();
        }
        if (signal?.aborted) throw new Error('Stopped before provisioning.');
        if (
          ![...requiredTools, ...(effective(s).requiredTools ?? [])].every((t) =>
            r.capabilities.tools.includes(t),
          )
        )
          throw new Error('Required tools are no longer available.');
      } catch (e) {
        r.online = false;
        s.assignment.state = 'released';
        await save();
        await auditDispatch(s, {
          decision: 'allow',
          outcome: 'failed',
          revisions: { executionGrantDigest: grant.digest },
          execution: {
            environmentId: r.environmentId,
            runnerId: r.id,
            profileId: grant.profileId,
          },
          observations: { failureClass: 'runner-probe-failed' },
        });
        return {
          reason:
            'Runner probe failed before execution. Refresh health or wait for another eligible runner.',
        };
      }
      if (!s.workspace) {
        s.runnerId = r.id;
        s.workspaceRequest ??= `task-${s.id}-${randomUUID().slice(0, 8)}`;
        event(s, 'placement_reserved', {
          assignment: s.assignment,
          workspaceId: s.workspaceRequest,
          profileId: grant.profileId,
          policyDigest: grant.digest,
        });
        await save();
        try {
          s.workspace = await execute(
            r,
            { action: 'provision', repository: r.repository, workspaceId: s.workspaceRequest },
            signal,
          );
        } catch (e) {
          s.assignment.state = 'uncertain';
          s.assignment.message =
            'Workspace provisioning may have started. Inspect the original environment before reconciliation.';
          event(s, 'placement_uncertain', { message: s.assignment.message });
          await save();
          await auditDispatch(s, {
            decision: 'allow',
            outcome: 'uncertain',
            revisions: { executionGrantDigest: grant.digest },
            execution: {
              environmentId: r.environmentId,
              runnerId: r.id,
              workspaceId: s.workspaceRequest,
              profileId: grant.profileId,
            },
            observations: {
              failureClass: 'runner-provision-uncertain',
              reconciliationRequired: true,
            },
          });
          throw e;
        }
      }
      s.assignment.state = 'running';
      event(s, 'placement_assigned', {
        runnerId: r.id,
        environmentId: r.environmentId,
        token: s.assignment.token,
        profileId: grant.profileId,
        policyDigest: grant.digest,
      });
      await save();
      await auditDispatch(s, {
        decision: 'allow',
        outcome: 'started',
        revisions: { executionGrantDigest: grant.digest },
        execution: {
          environmentId: r.environmentId,
          runnerId: r.id,
          workspaceId: s.workspace?.id ?? s.workspaceRequest,
          profileId: grant.profileId,
        },
      });
      return { runner: r };
    },
    async uncertain(s, message) {
      if (s.assignment) {
        s.assignment.state = 'uncertain';
        s.assignment.message = message;
        event(s, 'placement_uncertain', { message });
        await save();
      }
    },
    async release(s) {
      if (s.assignment && s.assignment.state !== 'uncertain') s.assignment.state = 'released';
      await save();
    },
    async reconcile(s, c) {
      if (
        !s.assignment ||
        s.assignment.state !== 'uncertain' ||
        c.token !== s.assignment.token ||
        c.confirmStopped !== true
      )
        throw new Error(
          'Confirm the exact uncertain assignment has stopped on its original environment.',
        );
      s.assignment.state = 'released';
      event(s, 'placement_reconciled', { token: c.token, actor: s.lease?.label });
      await save();
    },
    snapshot() {
      return {
        environments: state.environments.map((e) => ({
          ...e,
          load: load(e.id, true),
          backgroundLoad: backgroundLoad(e.id, true),
        })),
        runnerPools: state.runnerPools,
        environmentAccessBindings: access.bindings(),
        scheduler: state.scheduler,
        runners: state.runners.map((r) => ({
          ...r,
          load: load(r.id),
          backgroundLoad: backgroundLoad(r.id),
        })),
      };
    },
  };
}
