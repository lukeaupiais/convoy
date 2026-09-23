const denied = () => {
  throw new Error('Not authorized.');
};

const localOnly = new Set([
  // These legacy resources do not carry tenant ownership yet. Until they do,
  // only the deployment bootstrap principal may mutate or export them.
  'deleteBoardTemplate',
  'saveBoardTemplate',
]);

const projectWrite = new Set([
  'attachTicketFile',
  'createTicket',
  'importTickets',
  'removeTicketFile',
  'updateTicket',
  'importExternalTickets',
]);

/**
 * Resolve command authority from persisted resource ownership. Caller supplied
 * organization/project fields are only used when creating a new resource.
 */
export function createCommandAuthorization({
  state,
  contextFor,
  requireProjectPermission,
  requireOrganizationPermission,
  isBootstrapPrincipal,
}) {
  const project = (id) => state.projects.find((value) => value.id === id);
  const ticket = (id) => state.tickets.find((value) => String(value.id) === String(id));
  const board = (id) => state.boards?.find((value) => value.id === id);
  const environment = (id) => state.environments?.find((value) => value.id === id);
  const runner = (id) => state.runners?.find((value) => value.id === id);
  const pool = (id) => state.runnerPools?.find((value) => value.id === id);
  const session = (id) => state.sessions?.[String(id)];

  function selectedOrganization(client, actor) {
    return contextFor(client, actor)?.organizationId;
  }

  async function organization(
    organizationId,
    permission,
    command,
    actor,
    { requireSelected = true } = {},
  ) {
    if (
      !organizationId ||
      (requireSelected && selectedOrganization(command.client, actor) !== organizationId)
    )
      denied();
    await requireOrganizationPermission(actor, organizationId, permission);
  }

  async function projectId(id, permission, command, actor) {
    const value = project(id);
    if (!value || selectedOrganization(command.client, actor) !== value.organizationId) denied();
    await requireProjectPermission(value.id, permission, actor);
    return value;
  }

  async function projectIds(ids, permission, command, actor) {
    if (!Array.isArray(ids) || ids.length === 0) denied();
    let organizationId;
    for (const id of new Set(ids)) {
      const value = await projectId(id, permission, command, actor);
      organizationId ??= value.organizationId;
      if (organizationId !== value.organizationId) denied();
    }
    return organizationId;
  }

  async function ticketId(id, permission, command, actor) {
    const value = ticket(id);
    if (!value) denied();
    await projectId(value.projectId, permission, command, actor);
    return value;
  }

  async function boardId(id, permission, command, actor) {
    const value = board(id);
    if (!value) denied();
    if (value.projectIds.length === 0) {
      if (!isBootstrapPrincipal(actor)) denied();
      return value;
    }
    await projectIds(value.projectIds, permission, command, actor);
    return value;
  }

  async function executionResource(value, command, actor) {
    if (!value?.organizationId) denied();
    await organization(value.organizationId, 'environment.manage', command, actor);
    return value;
  }

  async function authorize(command, actor) {
    if (command.action === 'validateSkill') return;
    if (localOnly.has(command.action)) {
      if (!isBootstrapPrincipal(actor)) denied();
      return;
    }

    if (command.action === 'saveProject') {
      const existing = command.id ? project(command.id) : undefined;
      const organizationId =
        existing?.organizationId ??
        command.organizationId ??
        selectedOrganization(command.client, actor);
      await organization(organizationId, 'project.manage', command, actor, {
        requireSelected: false,
      });
      if (
        command.teamId &&
        !state.organizations?.teams?.some(
          (candidate) =>
            candidate.id === command.teamId &&
            candidate.organizationId === organizationId &&
            candidate.state === 'active',
        )
      )
        denied();
      return;
    }

    if (command.action === 'saveTicketConnection') {
      const existing = command.id ? state.ticketConnections?.find((value) => value.id === command.id) : undefined;
      if (command.id && !existing) denied();
      if (existing && existing.organizationId !== command.organizationId) denied();
      await organization(command.organizationId, 'organization.manage', command, actor);
      return;
    }
    if (command.action === 'createDevelopmentTicket' || command.action === 'linkDevelopmentTicket' || command.action === 'unlinkDevelopmentTicket') {
      const support = await ticketId(command.supportTicketId, 'project.write', command, actor);
      const developmentProjectId = command.action === 'createDevelopmentTicket'
        ? command.projectId : ticket(command.developmentTicketId)?.projectId;
      const development = await projectId(developmentProjectId, 'project.write', command, actor);
      if (project(support.projectId)?.organizationId !== development.organizationId) denied();
      return;
    }
    if (command.action === 'deleteTicketConnection' || command.action === 'probeTicketConnection') {
      const existing = state.ticketConnections?.find((value) => value.id === command.id);
      if (!existing) denied();
      await organization(existing.organizationId, 'organization.manage', command, actor);
      return;
    }
    if (command.action === 'publishTicket') {
      const value = await ticketId(command.ticketId, 'project.write', command, actor);
      const connection = state.ticketConnections?.find((item) => item.id === command.connectionId);
      if (!connection || project(value.projectId)?.organizationId !== connection.organizationId) denied();
      return;
    }
    if (command.action === 'reconcileTicketPublish') {
      const value = await ticketId(command.ticketId, 'project.write', command, actor);
      await organization(project(value.projectId).organizationId, 'organization.manage', command, actor);
      return;
    }
    if (command.action === 'syncExternalTicket') {
      await ticketId(command.ticketId, 'project.write', command, actor);
      return;
    }
    if (command.action === 'importExternalTickets') {
      const value = await projectId(command.projectId, 'project.write', command, actor);
      const connection = state.ticketConnections?.find((item) => item.id === command.connectionId);
      if (!connection || value.organizationId !== connection.organizationId) denied();
      return;
    }
    if (projectWrite.has(command.action)) {
      const id = command.projectId ?? ticket(command.taskId)?.projectId;
      await projectId(id, 'project.write', command, actor);
      return;
    }

    if (command.action === 'saveBoard') {
      const existing = command.id ? board(command.id) : undefined;
      if (command.id && !existing) denied();
      const requestedProjectIds =
        command.projectIds ??
        (isBootstrapPrincipal(actor)
          ? state.projects
              .filter(
                (value) => value.organizationId === selectedOrganization(command.client, actor),
              )
              .map((value) => value.id)
          : undefined);
      if ((existing?.projectIds ?? requestedProjectIds)?.length === 0) {
        if (!isBootstrapPrincipal(actor)) denied();
        return;
      }
      // Existing ownership is authoritative; additions must be authorized too.
      await projectIds(
        existing?.projectIds ?? requestedProjectIds,
        'project.write',
        command,
        actor,
      );
      if (command.projectIds) await projectIds(command.projectIds, 'project.write', command, actor);
      const policyChanged = command.creationPolicy &&
        JSON.stringify(command.creationPolicy) !== JSON.stringify(existing?.creationPolicy ?? { mode: 'convoy' });
      const destinationsChanged = command.destinationConnectionIds &&
        JSON.stringify([...command.destinationConnectionIds].sort()) !== JSON.stringify([...(existing?.destinationConnectionIds ?? [])].sort());
      if (policyChanged || destinationsChanged) await projectIds(
        existing?.projectIds ?? requestedProjectIds,
        'project.manage', command, actor,
      );
      return;
    }
    if (command.action === 'deleteBoard') {
      await boardId(command.id, 'project.write', command, actor);
      return;
    }
    if (command.action === 'createBoardFromTemplate') {
      await projectIds(command.projectIds, 'project.write', command, actor);
      return;
    }
    if (command.action === 'setBoardPlacement' || command.action === 'clearBoardPlacement') {
      const targetBoard = await boardId(command.boardId, 'project.write', command, actor);
      const targetTicket = await ticketId(command.ticketId, 'project.write', command, actor);
      if (!targetBoard.projectIds.includes(targetTicket.projectId)) denied();
      return;
    }

    if (command.action === 'connectRemote') {
      const organizationId = await projectIds(command.projectIds, 'project.manage', command, actor);
      if (command.organizationId && command.organizationId !== organizationId) denied();
      await organization(organizationId, 'environment.manage', command, actor);
      return;
    }
    if (command.action === 'registerRunner') {
      const targetEnvironment = command.environmentId
        ? environment(command.environmentId)
        : undefined;
      if (command.environmentId && !targetEnvironment) denied();
      const organizationId =
        targetEnvironment?.organizationId ??
        command.organizationId ??
        selectedOrganization(command.client, actor);
      await organization(organizationId, 'environment.manage', command, actor);
      if (command.projectIds?.length) {
        const projectsOrganization = await projectIds(
          command.projectIds,
          'project.manage',
          command,
          actor,
        );
        if (projectsOrganization !== organizationId) denied();
      }
      return;
    }
    if (command.action === 'probeRunner' || command.action === 'updateRunner') {
      const value = await executionResource(runner(command.runnerId), command, actor);
      if (command.organizationId && command.organizationId !== value.organizationId) denied();
      if (command.projectIds?.length) {
        const projectsOrganization = await projectIds(
          command.projectIds,
          'project.manage',
          command,
          actor,
        );
        if (projectsOrganization !== value.organizationId) denied();
      }
      return;
    }
    if (command.action === 'saveEnvironment') {
      const existing = command.id ? environment(command.id) : undefined;
      if (command.id && !existing) denied();
      const organizationId =
        existing?.organizationId ??
        command.organizationId ??
        selectedOrganization(command.client, actor);
      if (existing && command.organizationId && command.organizationId !== organizationId) denied();
      await organization(organizationId, 'environment.manage', command, actor);
      return;
    }
    if (command.action === 'saveRunnerPool') {
      const existing = command.id ? pool(command.id) : undefined;
      if (command.id && !existing) denied();
      const resolvedRunners = (command.runnerIds ?? []).map(runner);
      if (resolvedRunners.some((value) => !value)) denied();
      const organizationId =
        existing?.organizationId ??
        command.organizationId ??
        resolvedRunners[0]?.organizationId ??
        selectedOrganization(command.client, actor);
      if (existing && command.organizationId && command.organizationId !== organizationId) denied();
      if (resolvedRunners.some((value) => value.organizationId !== organizationId)) denied();
      await organization(organizationId, 'environment.manage', command, actor);
      return;
    }
    if (command.action === 'setPlacement' || command.action === 'setExecutionProfile') {
      const id = command.taskId ? ticket(command.taskId)?.projectId : command.projectId;
      await projectId(id, 'project.manage', command, actor);
      return;
    }

    if (command.action === 'setProjectProfile') {
      await projectId(command.projectId, 'project.manage', command, actor);
      return;
    }
    if (command.action === 'setScheduler') {
      await organization(command.organizationId, 'environment.manage', command, actor);
      return;
    }
    if (
      [
        'exportSkill',
        'publishExtension',
        'publishProfile',
        'publishSkill',
        'setToolEnabled',
      ].includes(command.action)
    ) {
      await organization(command.organizationId, 'organization.manage', command, actor);
      return;
    }
    if (command.action === 'saveWorkflow' || command.action === 'saveWorkflowDraft') {
      if (command.projectId) {
        await projectId(command.projectId, 'project.manage', command, actor);
      } else {
        await organization(command.organizationId, 'organization.manage', command, actor);
      }
      return;
    }
    if (command.action === 'saveWorkflowStartRule') {
      const existing = state.workflowStartRules?.find((value) => value.id === command.rule?.id);
      await projectId(existing?.projectId ?? command.rule?.projectId, 'project.manage', command, actor);
      return;
    }
    if (command.action === 'removeApprovalRule') {
      const rule = state.approvalRules.find((candidate) => candidate.id === command.ruleId);
      if (!rule) denied();
      if (rule.projectId) await projectId(rule.projectId, 'project.manage', command, actor);
      else await organization(rule.organizationId, 'organization.manage', command, actor);
      return;
    }
    if (command.action === 'publishInstruction') {
      if (command.scope === 'project') {
        await projectId(
          command.projectId ??
            command.target ??
            (isBootstrapPrincipal(actor) ? state.projects[0]?.id : undefined),
          'project.manage',
          command,
          actor,
        );
        return;
      }
      if (command.scope === 'task') {
        const targetSession = session(command.target);
        if (!targetSession?.projectId) denied();
        await projectId(targetSession.projectId, 'project.manage', command, actor);
        return;
      }
      if (command.scope === 'environment') {
        const target = environment(command.target) ?? runner(command.target);
        await executionResource(target, command, actor);
        return;
      }
      if (command.scope === 'organization') {
        if (!command.target && isBootstrapPrincipal(actor)) return;
        await organization(command.target, 'organization.manage', command, actor);
        return;
      }
      if (!isBootstrapPrincipal(actor)) denied();
      return;
    }

    if (command.action === 'createConversation') {
      if (!command.projectId && isBootstrapPrincipal(actor)) return;
      await projectId(command.projectId, 'project.write', command, actor);
      return;
    }
    if (command.action === 'openTicketConversation' || command.action === 'runTicket') {
      await ticketId(command.ticketId, 'project.execute', command, actor);
      return;
    }
    if (command.action === 'ensure') {
      const existing = ticket(command.taskId);
      if (existing) await projectId(existing.projectId, 'project.write', command, actor);
      else if (!isBootstrapPrincipal(actor)) denied();
      return;
    }
    if (command.action === 'probeModel') {
      const context = contextFor(command.client, actor);
      if (!context) denied();
      await requireOrganizationPermission(actor, context.organizationId, 'provider.use');
      return;
    }
  }

  async function authorizeSessionReferences(command, actor) {
    if (['linkTicket', 'requestExecution'].includes(command.action))
      await ticketId(command.ticketId, 'project.write', command, actor);
    if (command.action === 'configure' && command.runnerId)
      await executionResource(runner(command.runnerId), command, actor);
  }

  return { authorize, authorizeSessionReferences };
}
