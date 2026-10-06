import type { RuntimeState, WorkflowDefinition, WorkflowRun } from '../../shared/api/runtime';

export function independentWorkflowRuns(state: RuntimeState, projectId?: string) {
  return (state.workflowRuns ?? []).filter(
    (run) => run.independent === true && (!projectId || run.projectId === projectId),
  );
}

export function workflowsForProject(state: RuntimeState, projectId: string) {
  const project = state.projects.find((value) => value.id === projectId);
  if (!project) return [];
  return state.workflows
    .filter(
      (workflow) =>
        workflow.organizationId === project.organizationId &&
        (!workflow.projectId || workflow.projectId === project.id) &&
        (!workflow.teamId || workflow.teamId === project.teamId),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || (right.version ?? 0) - (left.version ?? 0),
    );
}

export function workflowOverview(state: RuntimeState, projectId: string) {
  const project = state.projects.find((value) => value.id === projectId);
  if (!project) return [];
  const definitions = new Map<string, WorkflowDefinition>();
  const rank = (value: WorkflowDefinition) => (value.projectId ? 3 : value.teamId ? 2 : 1);
  for (const definition of workflowsForProject(state, projectId)) {
    const previous = definitions.get(definition.id);
    if (
      !previous ||
      rank(definition) > rank(previous) ||
      (rank(definition) === rank(previous) && (definition.version ?? 0) > (previous.version ?? 0))
    ) {
      definitions.set(definition.id, definition);
    }
  }
  const drafts = Object.values(state.workflowDrafts ?? {}).filter(
    ({ workflow }) =>
      (workflow.organizationId ?? 'personal') === project.organizationId &&
      (!workflow.projectId || workflow.projectId === projectId) &&
      (!workflow.teamId || workflow.teamId === project.teamId),
  );
  for (const { workflow } of drafts) {
    if (!definitions.has(workflow.id)) definitions.set(workflow.id, workflow);
  }
  return [...definitions.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workflow) => {
      const latestRun = (state.workflowRuns ?? [])
        .filter((run) => run.projectId === projectId && run.workflowId === workflow.id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      return {
        workflow,
        draft: drafts.some((record) => record.workflow.id === workflow.id),
        latestRun,
      };
    });
}

export function workflowForRun(run: WorkflowRun, workflows: WorkflowDefinition[]) {
  return workflows.find(
    (workflow) => workflow.id === run.workflowId && workflow.version === run.workflowVersion,
  );
}

export function currentWorkflowRunDetail(
  selectedRunId: string,
  detail: WorkflowRun | null,
  authorizedProjectIds: string[],
) {
  if (
    !detail ||
    detail.id !== selectedRunId ||
    detail.independent !== true ||
    !authorizedProjectIds.includes(detail.projectId)
  )
    return null;
  return detail;
}

export function workflowRunCommandTarget(
  selectedRunId: string,
  detail: WorkflowRun | null,
  authorizedProjectIds: string[],
) {
  const current = currentWorkflowRunDetail(selectedRunId, detail, authorizedProjectIds);
  return current ? { workflowRunId: current.id, instance: current.instance } : null;
}

export function runControlEligibility(run: WorkflowRun, now = Date.now()) {
  const leaseActive = Boolean(run.lease && run.lease.expiresAt > now);
  const ownsControl = Boolean(leaseActive && run.lease?.ownedByCurrentCaller === true);
  return {
    ownsControl,
    canClaim: !leaseActive || ownsControl,
    controlledElsewhere: leaseActive && !ownsControl,
  };
}

export function runAllowsContinue(status: string) {
  return ['awaiting_continue', 'paused', 'failed', 'interrupted', 'awaiting_submission'].includes(
    status,
  );
}

export function runIsTerminal(run: WorkflowRun) {
  return ['completed', 'cancelled'].includes(run.status);
}
