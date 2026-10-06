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

export function publishedWorkflowsForProject(state: RuntimeState, projectId: string) {
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
  return [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// An existing rule keeps its exact pin until the user chooses another workflow.
export function workflowSelectionOptions(
  state: RuntimeState,
  projectId: string,
  selected?: { id: string; version?: number },
) {
  const pinned =
    selected &&
    workflowsForProject(state, projectId).find(
      (value) => value.id === selected.id && value.version === selected.version,
    );
  return publishedWorkflowsForProject(state, projectId).map((value) =>
    pinned?.id === value.id ? pinned : value,
  );
}

export function workflowOverview(state: RuntimeState, projectId: string) {
  const project = state.projects.find((value) => value.id === projectId);
  if (!project) return [];
  const definitions = new Map(
    publishedWorkflowsForProject(state, projectId).map((value) => [value.id, value]),
  );
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

export function workflowRunLabel(status: string) {
  const labels: Record<string, string> = {
    waiting_gate: 'Waiting for review',
    awaiting_continue: 'Ready to continue',
    awaiting_submission: 'Waiting for submission',
    waiting_event: 'Waiting for event',
  };
  return labels[status] ?? status.replaceAll('_', ' ');
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

export async function acquireWorkflowRunControl(
  expected: WorkflowRun,
  current: () => WorkflowRun | null,
  claim: (id: string) => Promise<unknown>,
  refresh: (id: string) => Promise<WorkflowRun>,
) {
  const matches = (run: WorkflowRun | null) =>
    Boolean(
      run &&
      run.independent &&
      run.id === expected.id &&
      run.projectId === expected.projectId &&
      run.instance === expected.instance &&
      run.nodeId === expected.nodeId,
    );
  if (!matches(current())) throw new Error('The workflow activity changed. Review it again.');
  if (runControlEligibility(current()!).ownsControl) return current()!;
  if (!runControlEligibility(current()!).canClaim)
    throw new Error('This workflow run is controlled elsewhere.');
  await claim(expected.id);
  const fresh = await refresh(expected.id);
  if (!matches(current()) || !matches(fresh))
    throw new Error('The workflow activity changed. Review it again.');
  if (!runControlEligibility(fresh).ownsControl)
    throw new Error('Unable to acquire workflow control.');
  return fresh;
}

export function runAllowsContinue(status: string) {
  return ['awaiting_continue', 'paused', 'failed', 'interrupted', 'awaiting_submission'].includes(
    status,
  );
}

export function runIsTerminal(run: WorkflowRun) {
  return ['completed', 'cancelled'].includes(run.status);
}
