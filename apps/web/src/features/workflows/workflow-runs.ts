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
