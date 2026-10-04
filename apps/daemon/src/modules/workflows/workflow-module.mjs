import { createWorkflowRegistry } from './workflow-registry.mjs';
import { randomUUID } from 'node:crypto';

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
  state.workflowRuns ??= {};
  for (const run of Object.values(state.workflowRuns)) {
    if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
      if (['waiting_gate', 'waiting_event', 'awaiting_continue', 'awaiting_submission', 'paused'].includes(run.flow.status))
        run.attempt.status = 'waiting';
      else if (run.flow.status === 'ready') run.attempt.status = 'ready';
      else {
        run.attempt.status = 'uncertain';
        run.flow.resumeStatus = run.flow.status;
        run.flow.status = 'interrupted';
        run.status = 'interrupted';
      }
    }
  }
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
  defaultPrincipal = null,
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
      const visibleRuns = Object.values(state.workflowRuns ?? {}).filter((run) =>
        (!organizationId || run.organizationId === organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(run.projectId)));
      const terminal = (run) => ['completed', 'cancelled'].includes(run.flow?.status ?? run.status);
      visibleRuns.sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || String(b.updatedAt ?? b.startedAt ?? '').localeCompare(String(a.updatedAt ?? a.startedAt ?? '')));
      return {
        workflowRunsTotal: visibleRuns.length,
        workflowRunsTruncated: visibleRuns.length > 200,
        workflowRuns: visibleRuns.slice(0, 200).map(publicRun),
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
    async startRun({ projectId, organizationId, principal, workflow, activeTicketId = null }) {
      if (!principal) throw new Error('A governed principal is required to start a workflow run.');
      state.workflowRuns ??= {};
      const id = randomUUID();
      const run = {
        id, projectId, organizationId, principal: principal ? structuredClone(principal) : null, executionPrincipal: principal ? structuredClone(principal) : null,
        workflow: structuredClone(workflow), independentRun: true,
        activeTicketId, title: workflow.name, status: 'ready', sequence: 0, events: [],
        checks: [], messages: [], lease: null, startedAt: new Date().toISOString(),
      };
      state.workflowRuns[id] = run;
      try { await engine.start(run); }
      catch (error) { delete state.workflowRuns[id]; throw error; }
      return structuredClone(run);
    },
    async decideRun(run, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run)
        throw new Error('Workflow run is not available.');
      if (run.flow?.instance !== command.instance)
        throw new Error('This workflow step has changed. Refresh before acting.');
      const action = command.decision === 'approve' ? 'approveGate' : 'requestChanges';
      const context = state.sessions[run.sessionId] ?? run;
      await engine.decide(context, { action, instance: command.instance, feedback: command.feedback, actor: command.actor, principal: command.principal });
      run.decisions ??= [];
      run.decisions.push({ instance: command.instance, decision: command.decision, actor: command.actor, principal: structuredClone(command.principal), at: new Date().toISOString() });
      return structuredClone(run);
    },
    claimRun(run, { client, label, actorKey }) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.lease && run.lease.expiresAt > Date.now() && (run.lease.client !== client || run.lease.principalKey !== actorKey))
        throw new Error('Workflow run is controlled by another client.');
      run.lease = { id: randomUUID(), client, principalKey: actorKey, label, expiresAt: Date.now() + 90000 };
      return run.lease;
    },
    requireRunLease(run, { client, actorKey }) {
      if (!run?.lease || run.lease.expiresAt < Date.now() || run.lease.client !== client || run.lease.principalKey !== actorKey)
        throw new Error('Claim workflow run control first.');
      run.lease.expiresAt = Date.now() + 90000;
      return run.lease;
    },
    releaseRun(run, identity) {
      this.requireRunLease(run, identity);
      run.lease = null;
    },
    async cancelRun(run, context) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      await requestStop(context);
      await engine.pause(context, true);
      const unresolved = Object.entries(state.workflowEffectLedger ?? {}).some(([key, effect]) =>
        key.startsWith(`${run.id}:`) && ['pending', 'uncertain'].includes(effect.status));
      if (run.attempt && unresolved) run.attempt.status = 'uncertain';
      else if (run.attempt && !['completed', 'uncertain'].includes(run.attempt.status)) run.attempt.status = 'cancelled';
      const completedEffect = run.attempt && state.workflowEffectLedger?.[`${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`];
      if (completedEffect?.status === 'succeeded') {
        run.attempt.status = 'completed';
        run.attempt.outcome = 'success';
        run.attempt.effectKey = `${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`;
        run.attempt.effectResult = structuredClone(completedEffect.result);
        run.attempt.completedAt ??= completedEffect.reconciledAt ?? completedEffect.at;
      }
    },
    async reconcileRun(run, context, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      await effects.reconcile(context, command);
      const unresolved = Object.entries(state.workflowEffectLedger ?? {}).some(([key, effect]) =>
        key.startsWith(`${run.id}:`) && ['pending', 'uncertain'].includes(effect.status));
      if (!unresolved && context.flow.status === 'cancelled' && run.attempt?.instance === command.instance)
        run.attempt.status = 'cancelled';
      if (run.attempt?.instance === command.instance && run.attempt.status === 'uncertain' && !['failed', 'interrupted'].includes(context.flow.status))
        run.attempt.status = 'ready';
      const effectKey = run.attempt?.instance === command.instance
        ? `${run.id}:${command.instance}:${run.attempt.nodeId}` : null;
      const effect = effectKey && state.workflowEffectLedger?.[effectKey];
      if (effect?.status === 'succeeded') {
        run.attempt.status = 'completed';
        run.attempt.outcome = 'success';
        run.attempt.effectKey = effectKey;
        run.attempt.effectResult = structuredClone(effect.result);
        run.attempt.completedAt ??= effect.reconciledAt ?? effect.at;
      }
    },
    async continueRun(run, context, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.attempt?.status === 'uncertain' || context.assignment?.state === 'uncertain' || context.interruption?.needsReview)
        throw new Error('Inspect and reconcile the interrupted agent activity before continuing the workflow.');
      if (run.flow?.instance !== command.instance) throw new Error('This workflow step has changed. Refresh before acting.');
      await engine.decide(context, { action: 'continueWorkflow', instance: command.instance });
    },
    run(id) { return state.workflowRuns?.[id] ?? null; },
    readRun(id) {
      const run = state.workflowRuns?.[id];
      if (!run) return null;
      return structuredClone(publicRun(run));
    },
    bindSessionRun(session, flow, migrationPrincipal = defaultPrincipal) {
      if (session.independentRun) return;
      state.workflowRuns ??= {};
      const previous = session.workflowRunId && state.workflowRuns[session.workflowRunId];
      if (previous && previous.id !== flow.id && previous.sessionId === session.id) {
        previous.archivedAt ??= new Date().toISOString();
        delete session.workflowRunId;
      }
      const id = flow.id;
      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      let owner = state.workflowRuns[id];
      if (owner && owner.sessionId !== session.id) throw new Error('Workflow run identity is already bound.');
      if (!owner) owner = state.workflowRuns[id] = {
        id, independentRun: false, sessionId: session.id,
        projectId: session.projectId, organizationId: project?.organizationId ?? 'personal',
        principal: session.executionPrincipal ? structuredClone(session.executionPrincipal) : structuredClone(migrationPrincipal),
        workflow: structuredClone(session.workflow), flow,
      };
      if (!owner.principal) throw new Error('Workflow run has no resolvable execution principal.');
      else if (flow) {
        owner.workflow = structuredClone(session.workflow);
        owner.flow = flow;
      }
      session.workflowRunId = id;
      installSessionFlowProjection(session, state);
    },
    archiveSessionRun(session, details = {}) {
      const id = session.workflowRunId;
      const owner = id && state.workflowRuns?.[id];
      if (owner && owner.sessionId === session.id) {
        if (details.ticketId) owner.ticketId = details.ticketId;
        owner.archivedAt ??= new Date().toISOString();
        delete session.workflowRunId;
        installSessionFlowProjection(session, state);
        return owner.id;
      }
      return null;
    },
    recoverRuns() {
      for (const run of Object.values(state.workflowRuns ?? {})) {
        // Actor identity is audit evidence; a persisted lease is not authority
        // after daemon restart. Reclaim must be explicit, matching sessions.
        run.lease = null;
        if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
          run.attempt.status = 'uncertain';
          run.flow.resumeStatus = run.flow.status;
          run.flow.status = 'interrupted';
          run.status = 'interrupted';
        }
      }
    },
    attachAgentSession(run, session) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.sessionId && run.sessionId !== session.id) throw new Error('Workflow run already has an agent session.');
      run.sessionId = session.id;
      run.agentSessionId = session.id;
      session.workflowRunId = run.id;
      session.workflow = structuredClone(run.workflow);
      session.projectId = run.projectId;
      session.activeTicketId = run.activeTicketId;
      session.executionPrincipal = structuredClone(run.principal);
      run.flow.model ??= session.model;
      if (!run.flow.aliases) run.flow.aliases = {};
      if (!run.flow.bindings) run.flow.bindings = {};
      if (session.currentAgentSessionId) {
        run.flow.aliases.main ??= session.currentAgentSessionId;
        run.flow.lastAgent ??= session.currentAgentSessionId;
      }
      installSessionFlowProjection(session, state);
    },
    adoptSessionRun(session, migrationPrincipal = defaultPrincipal) {
      for (const old of session.pastRuns ?? []) {
        if (!old?.id || state.workflowRuns[old.id]) continue;
        const project = state.projects.find((candidate) => candidate.id === session.projectId);
        state.workflowRuns[old.id] = {
          id: old.id, independentRun: false, sessionId: session.id,
          projectId: session.projectId, organizationId: project?.organizationId ?? 'personal',
          principal: session.executionPrincipal ? structuredClone(session.executionPrincipal) : structuredClone(migrationPrincipal),
          workflow: structuredClone(old.workflow ?? state.workflows.filter((definition) => definition.id === (old.workflowId ?? session.workflow?.id) && definition.version === (old.workflowVersion ?? session.workflow?.version)).at(-1) ?? null), flow: structuredClone(old),
          ...(old.ticketId ? { ticketId: old.ticketId } : {}), archivedAt: old.endedAt ?? old.startedAt ?? new Date().toISOString(),
        };
      }
      delete session.pastRuns;
      if (session.workflowRunId && state.workflowRuns?.[session.workflowRunId]?.sessionId === session.id) {
        installSessionFlowProjection(session, state);
        return;
      }
      if (!session.workflow || !session.flow) { installSessionHistoryProjection(session, state); return; }
      const flow = session.flow;
      if (session.workflowRunId && state.workflowRuns?.[session.workflowRunId]?.sessionId === session.id) {
        const owner = state.workflowRuns[session.workflowRunId];
        if (owner.flow) session.flow = owner.flow;
        session.workflowRunId = owner.id;
        installSessionFlowProjection(session, state);
        return;
      }
      this.bindSessionRun(session, flow, migrationPrincipal);
      installSessionHistoryProjection(session, state);
    },
  };
}

function publicRun(run) {
  return {
    id: run.id, organizationId: run.organizationId, projectId: run.projectId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}), independent: Boolean(run.independentRun),
    workflowId: run.flow?.workflowId, workflowVersion: run.flow?.workflowVersion,
    status: run.flow?.status ?? run.status, nodeId: run.flow?.nodeId,
    instance: run.flow?.instance, activeTicketId: run.activeTicketId ?? run.ticketId,
    startedAt: run.flow?.startedAt ?? run.startedAt, updatedAt: run.updatedAt ?? run.flow?.history?.at(-1)?.at ?? run.flow?.startedAt ?? run.startedAt,
    attempt: run.attempt, activityAttempts: [...(run.activityAttempts ?? []).slice(-50), ...(run.attempt ? [run.attempt] : [])],
    history: (run.flow?.history ?? []).slice(-200).map(({ nodeId, instance, outcome, at, to, submission }) => ({ nodeId, instance, outcome, at, to, ...(typeof submission?.summary === 'string' ? { summary: submission.summary.slice(0, 500) } : {}) })),
    historyTotal: (run.flow?.history ?? []).length,
    historyTruncated: (run.flow?.history ?? []).length > 200,
    lease: run.lease ? { id: run.lease.id, client: run.lease.client, label: run.lease.label, expiresAt: run.lease.expiresAt } : null,
    decisions: (run.decisions ?? []).slice(-50),
    decisionsTotal: (run.decisions ?? []).length,
    decisionsTruncated: (run.decisions ?? []).length > 50,
  };
}

function installSessionFlowProjection(session, state) {
  if (Object.getOwnPropertyDescriptor(session, 'flow')?.get) return;
  delete session.flow;
  Object.defineProperty(session, 'flow', {
    configurable: true,
    enumerable: false,
    get() { return state.workflowRuns?.[this.workflowRunId]?.flow ?? null; },
    set(value) {
      if (value == null) { delete this.workflowRunId; return; }
      const owner = state.workflowRuns?.[this.workflowRunId]; if (owner) owner.flow = value;
    },
  });
  installSessionHistoryProjection(session, state);
}

function installSessionHistoryProjection(session, state) {
  if (Object.getOwnPropertyDescriptor(session, 'pastRuns')?.get) return;
  delete session.pastRuns;
  Object.defineProperty(session, 'pastRuns', {
    configurable: true,
    enumerable: false,
    get() { return Object.values(state.workflowRuns ?? {}).filter((run) => run.sessionId === this.id && run.id !== this.workflowRunId).sort((a, b) => String(a.flow?.startedAt ?? '').localeCompare(String(b.flow?.startedAt ?? ''))).map((run) => ({ ...structuredClone(run.flow), workflow: structuredClone(run.workflow), ...(run.ticketId ? { ticketId: run.ticketId } : {}) })); },
  });
}
