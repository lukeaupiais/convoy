import { createWorkflowRegistry } from './workflow-registry.mjs';

const commands = ['saveWorkflow', 'saveWorkflowDraft', 'saveAutomation'];
const sessionCommands = [
  'retryAutomationDecision',
  'reconcileWorkflowEffect',
  'startWorkflow',
  'pauseWorkflow',
  'cancelWorkflow',
  'continueWorkflow',
  'approveGate',
  'requestChanges',
  'reviseSubmission',
];

export function migrateWorkflowState(state, { defaultWorkflow, normalize }) {
  state.workflows ??= [];
  if (!state.workflows.length) state.workflows.push(structuredClone(defaultWorkflow));
  // Templates are additive: upgrading Convoy must never rewrite an operator's
  // published graph or active-run pin, but every workspace should receive the
  // current proven delivery starting point exactly once.
  if (!state.workflows.some((workflow) => workflow.id === defaultWorkflow.id))
    state.workflows.push(structuredClone(defaultWorkflow));
  state.workflowDrafts ??= {};
  state.defaultWorkflowIds ??= { organizations: {}, projects: {} };
  state.defaultWorkflowIds.organizations ??= {};
  state.defaultWorkflowIds.projects ??= {};
  if (state.defaultWorkflowId && !state.defaultWorkflowIds.organizations.personal) {
    state.defaultWorkflowIds.organizations.personal = state.defaultWorkflowId;
  }
  state.workflows = state.workflows.map((workflow) => {
    try {
      return {
        ...normalize(workflow),
        organizationId: workflow.organizationId ?? 'personal',
        ...(workflow.teamId ? { teamId: workflow.teamId } : {}),
        ...(workflow.projectId ? { projectId: workflow.projectId } : {}),
        version: workflow.version ?? 1,
      };
    } catch {
      // Malformed historical definitions remain inspectable and fail safely on resume.
      return workflow;
    }
  });
  for (const draft of Object.values(state.workflowDrafts)) {
    draft.workflow.organizationId ??= 'personal';
  }
  const latest = state.workflows.at(-1);
  const latestNodes = latest?.nodes ?? latest?.steps ?? [];
  if (latestNodes.some((step) => step.requiresCheck && !step.checkCommand)) {
    const upgraded = structuredClone(latest);
    upgraded.version = state.workflows.length + 1;
    for (const step of upgraded.nodes ?? upgraded.steps)
      if (step.requiresCheck && !step.checkCommand) step.checkCommand = 'npm test';
    state.workflows.push(upgraded);
  }
}

/** Immutable workflow definitions and lease-authorized workflow-run decisions. */
export function createWorkflows({
  state,
  save,
  defaultWorkflow,
  normalize,
  validateBindings,
  engine,
  effects,
  requestStop,
  automations,
}) {
  migrateWorkflowState(state, { defaultWorkflow, normalize });
  const registry = createWorkflowRegistry({ state, save, normalize, validateBindings });
  return {
    id: 'workflows',
    commands,
    sessionCommands,
    snapshot({ scope } = {}) {
      const organizationId = scope?.organizationId;
      const visible = (workflow) =>
        (!organizationId || workflow.organizationId === organizationId) &&
        (!workflow.projectId || !scope?.projectIds || scope.projectIds.includes(workflow.projectId)) &&
        (!workflow.teamId || state.projects.some((project) =>
          project.teamId === workflow.teamId && project.organizationId === workflow.organizationId &&
          (!scope?.projectIds || scope.projectIds.includes(project.id))));
      return {
        workflows: state.workflows.filter(visible),
        workflowDrafts: Object.fromEntries(
          Object.entries(state.workflowDrafts).filter(
            ([, draft]) => visible(draft.workflow),
          ),
        ),
        automations: automations.snapshot(scope),
        defaultWorkflowIds: {
          organizations: organizationId && state.defaultWorkflowIds.organizations[organizationId]
            ? { [organizationId]: state.defaultWorkflowIds.organizations[organizationId] } : {},
          projects: Object.fromEntries((scope?.projectIds ?? state.projects.map((project) => project.id)).filter((id) => state.defaultWorkflowIds.projects[id])
            .map((id) => [id, state.defaultWorkflowIds.projects[id]])),
        },
        defaultWorkflowId:
          (scope?.projectIds ?? [])
            .map((id) => state.defaultWorkflowIds.projects[id])
            .find(Boolean) ?? state.defaultWorkflowIds.organizations[organizationId],
      };
    },
    registry,
    selection(value, session) {
      const project = state.projects.find((candidate) => candidate.id === session?.projectId);
      const organizationId = project?.organizationId ?? 'personal';
      const id =
        typeof value === 'string'
          ? value
          : (state.defaultWorkflowIds.projects[project?.id] ??
            state.defaultWorkflowIds.organizations[organizationId] ??
            state.workflows.filter((workflow) => workflow.organizationId === organizationId).at(-1)
              ?.id);
      const chosen = state.workflows
        .filter(
          (workflow) =>
            workflow.id === id &&
            workflow.organizationId === organizationId &&
            (!workflow.projectId || workflow.projectId === project?.id) &&
            (!workflow.teamId || workflow.teamId === project?.teamId),
        )
        .at(-1);
      if (!chosen) throw new Error('Workflow not found.');
      return {
        ...normalize(chosen),
        organizationId: chosen.organizationId,
        ...(chosen.teamId ? { teamId: chosen.teamId } : {}),
        ...(chosen.projectId ? { projectId: chosen.projectId } : {}),
        version: chosen.version,
      };
    },
    command(command, { validateClient, principal }) {
      validateClient(command.client);
      if (command.action === 'saveAutomation')
        return automations.save(command, principal);
      return command.action === 'saveWorkflow'
        ? registry.publish(command)
        : registry.saveDraft(command);
    },
    async sessionCommand(session, command) {
      if (command.action === 'retryAutomationDecision') return effects.retryTrigger(session, command);
      if (command.action === 'reconcileWorkflowEffect') return effects.reconcile(session, command);
      if (command.action === 'startWorkflow') return engine.start(session);
      if (command.action === 'pauseWorkflow' || command.action === 'cancelWorkflow') {
        await requestStop(session);
        if (command.action === 'cancelWorkflow') await engine.pause(session, true);
        return;
      }
      return engine.decide(session, command);
    },
  };
}
