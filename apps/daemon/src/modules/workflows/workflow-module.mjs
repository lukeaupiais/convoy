import { createWorkflowRegistry } from './workflow-registry.mjs';
import { activityDigest, validateActivityValue, resolveActivityBindings } from './activity-data.mjs';
import { legacyActivityRef } from './activity-catalog.mjs';
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
  state.workflowEffectLedger ??= {};
  for (const run of Object.values(state.workflowRuns)) {
    if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
      if (['waiting_gate', 'waiting_event', 'awaiting_continue', 'awaiting_submission', 'paused'].includes(run.flow.status))
        run.attempt.status = 'waiting';
      else if (run.flow.status === 'ready') run.attempt.status = 'ready';
      else {
        const safelyRecomputable = ['pure', 'observation'].includes(run.attempt.effect);
        const mayHaveDispatched = run.attempt.dispatchStarted === true || run.attempt.dispatchStarted === undefined;
        run.attempt.status = !safelyRecomputable && mayHaveDispatched ? 'uncertain' : 'ready';
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
  // Published definitions are immutable approval material. Interpret legacy
  // operation nodes at read/dispatch boundaries; never rewrite their bytes here.
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
  activityCatalog,
  activityAvailable = () => true,
  prepareActivityIntent = async () => { throw new Error('Activity intent preparation is unavailable.'); },
}) {
  migrateWorkflowState(state, { defaultWorkflow, normalize });
  const registry = createWorkflowRegistry({ state, save, normalize, validateBindings });
  const readDefinition = workflow => {
    try {
      return {
        ...normalize(workflow), organizationId: workflow.organizationId ?? 'personal',
        ...(workflow.teamId ? { teamId: workflow.teamId } : {}),
        ...(workflow.projectId ? { projectId: workflow.projectId } : {}), version: workflow.version ?? 1,
      };
    } catch { return structuredClone(workflow); }
  };
  const visibleWorkflow = (workflow, scope) =>
    (!scope?.organizationId || (workflow.organizationId ?? 'personal') === scope.organizationId) &&
    (!workflow.projectId || !scope?.projectIds || scope.projectIds.includes(workflow.projectId)) &&
    (!workflow.teamId || state.projects.some(project =>
      project.teamId === workflow.teamId && project.organizationId === (workflow.organizationId ?? 'personal') &&
      (!scope?.projectIds || scope.projectIds.includes(project.id))));
  const activityDescriptors = scope => {
    const descriptors = new Map((activityCatalog?.all() ?? []).map(descriptor => [activityCatalog.key(descriptor.ref), {
      ...descriptor, digest: activityDigest(descriptor), available: Boolean(activityAvailable(descriptor.ref)),
    }]));
    const unavailableRefs = new Set();
    let unavailableTruncated = false;
    let unavailableAdded = 0;
    let projectionBytes = Buffer.byteLength(JSON.stringify([...descriptors.values()]));
    const visibleDefinitions = (state.workflows ?? []).filter(workflow => visibleWorkflow(workflow, scope));
    for (const workflow of visibleDefinitions) for (const node of workflow.nodes ?? workflow.steps ?? []) {
      const ref = node.activity ?? legacyActivityRef(node.operation);
      if (!ref || descriptors.has(`${ref.id}@${ref.revision}`)) continue;
      const key = `${ref.id}@${ref.revision}`;
      if (unavailableRefs.has(key)) continue;
      if (unavailableRefs.size >= 512) { unavailableTruncated = true; continue; }
      unavailableRefs.add(key);
      const placeholder = {
        ref: structuredClone(ref), inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
        cancellation: 'reconcile-after-dispatch', confirmation: 'human-reconciled', reconciliation: 'adapter',
        presentation: { label: 'Unavailable activity' }, available: false,
      };
      const bytes = Buffer.byteLength(JSON.stringify(placeholder));
      if (descriptors.size < 224 && projectionBytes + bytes <= 1_000_000) {
        descriptors.set(key, placeholder);
        projectionBytes += bytes;
        unavailableAdded += 1;
      } else unavailableTruncated = true;
    }
    return { descriptors: [...descriptors.values()].map(value => structuredClone(value)), unavailableTotal: unavailableRefs.size,
      unavailableTruncated: unavailableTruncated || unavailableAdded < unavailableRefs.size };
  };
  return {
    id: 'workflows',
    commands,
    sessionCommands,
    snapshot({ scope } = {}) {
      const organizationId = scope?.organizationId;
      const visible = (workflow) => visibleWorkflow(workflow, scope);
      const visibleRuns = Object.values(state.workflowRuns ?? {}).filter((run) =>
        (!organizationId || run.organizationId === organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(run.projectId)));
      const terminal = (run) => ['completed', 'cancelled'].includes(run.flow?.status ?? run.status);
      visibleRuns.sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || String(b.updatedAt ?? b.startedAt ?? '').localeCompare(String(a.updatedAt ?? a.startedAt ?? '')));
      return {
        workflowRunsTotal: visibleRuns.length,
        workflowRunsTruncated: visibleRuns.length > 200,
        workflowRuns: visibleRuns.slice(0, 200).map(publicRun),
        workflows: state.workflows.filter(workflow => visible({ ...workflow, organizationId: workflow.organizationId ?? 'personal' })).map(readDefinition),
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
        ...(() => {
          const projection = activityDescriptors(scope);
          return { workflowActivities: projection.descriptors, workflowActivitiesUnavailableTotal: projection.unavailableTotal,
            workflowActivitiesTruncated: projection.unavailableTruncated };
        })(),
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
            state.defaultWorkflowIds.organizations[organizationId]);
      if (!id) return null;
      const chosen = state.workflows
        .filter(
          (workflow) =>
            workflow.id === id &&
            (workflow.organizationId ?? 'personal') === organizationId &&
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
    async startRun({ projectId, organizationId, principal, workflow, activeTicketId = null, runInput = {} }) {
      if (!principal) throw new Error('A governed principal is required to start a workflow run.');
      state.workflowRuns ??= {};
      const id = randomUUID();
      const pinnedWorkflow = structuredClone(workflow);
      const workflowExecution = normalize(workflow);
      const checkedRunInput = validateActivityValue(runInput, workflowExecution.runInputSchema);
      const run = {
        id, projectId, organizationId, principal: principal ? structuredClone(principal) : null, executionPrincipal: principal ? structuredClone(principal) : null,
        workflow: structuredClone(pinnedWorkflow), independentRun: true,
        runInput: checkedRunInput, runInputDigest: activityDigest(checkedRunInput), activityOutputs: {},
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
      await engine.decide(context, { action, instance: command.instance, feedback: command.feedback, actor: command.actor, principal: command.principal,
        activityReservationId: command.activityReservationId, activityReservationDigest: command.activityReservationDigest });
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
      await requestStop(context, false, { awaitWork: false });
      await engine.pause(context, true);
      const unresolved = run.attempt?.effect !== 'pure' && run.attempt?.effect !== 'observation' &&
        run.attempt?.dispatchStarted !== false &&
        ['pending', 'uncertain'].includes(this.effectRecord(run.attempt.effectKey)?.status);
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
    placementAssignments() {
      return Object.values(state.workflowRuns ?? {}).filter(run => run.independentRun && !run.sessionId && run.assignment)
        .map(run => ({ id: run.id, projectId: run.projectId, organizationId: run.organizationId,
          runnerId: run.runnerId, assignment: structuredClone(run.assignment) }));
    },
    effectRecord(key) { return structuredClone(state.workflowEffectLedger?.[key] ?? null); },
    effectForAttempt(runId, instance, nodeId) {
      if (![runId, instance, nodeId].every(value => typeof value === 'string')) return null;
      return this.effectRecord(`${runId}:${instance}:${nodeId}`);
    },
    effectSummaries(projectIds) {
      const allowed = projectIds ? new Set(projectIds) : null;
      return Object.entries(state.workflowEffectLedger ?? {}).filter(([, effect]) => !allowed || allowed.has(effect.projectId))
        .map(([effectKey, effect]) => ({ effectKey, status: effect.status, operation: effect.operation, at: effect.at,
          ...(effect.reconciledAt ? { reconciledAt: effect.reconciledAt } : {}), ...(effect.message ? { message: effect.message } : {}),
          ...(effect.blockingReplyRequestId ? { blockingReplyRequestId: effect.blockingReplyRequestId } : {}) }));
    },
    resolveWorkflowResult(context) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const workflow = normalize(run.workflow);
      if (!workflow.resultSchema) return null;
      const result = resolveActivityBindings(workflow.resultBindings, workflow.resultSchema, {
        runInputSchema: workflow.runInputSchema, runInput: run.runInput, activityOutputs: run.activityOutputs,
      });
      const resultDigest = activityDigest(result);
      if (run.resultDigest && run.resultDigest !== resultDigest)
        throw new Error('Workflow result is immutable once recorded.');
      return { result, resultDigest };
    },
    recordWorkflowResult(context, resolved) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const value = resolved ?? this.resolveWorkflowResult(context);
      if (!value) return null;
      if (run.resultDigest && run.resultDigest !== value.resultDigest) throw new Error('Workflow result is immutable once recorded.');
      run.result = structuredClone(value.result);
      run.resultDigest = value.resultDigest;
      return { result: structuredClone(run.result), resultDigest: run.resultDigest };
    },
    saveEffectRecord(key, value) {
      if (typeof key !== 'string' || key.length > 500 || !value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Workflow effect record is invalid.');
      state.workflowEffectLedger ??= {};
      state.workflowEffectLedger[key] = structuredClone(value);
      return structuredClone(state.workflowEffectLedger[key]);
    },
    deleteEffectRecord(key) { delete state.workflowEffectLedger?.[key]; },
    getActivityRef(node) { return node?.activity ? structuredClone(node.activity) : legacyActivityRef(node?.operation); },
    activityDescriptor(ref) { return activityCatalog?.get(ref) ?? null; },
    activityApprovalSatisfied(run, nodeId) {
      if (!run || state.workflowRuns?.[run.id] !== run) return false;
      const workflow = normalize(run.workflow);
      const history = run.flow?.history?.at(-1);
      return Boolean(history && history.to === nodeId && history.outcome === 'approved' &&
        workflow.nodes.some(node => node.id === history.nodeId && node.kind === 'human') &&
        workflow.edges.some(edge => edge.from === history.nodeId && edge.to === nodeId && edge.outcome === 'approved'));
    },
    async reserveActivityIntent({ runId, gateNodeId, gateInstance, targetNodeId }) {
      const run = state.workflowRuns?.[runId];
      if (!run || run.flow?.status !== 'waiting_gate' || run.flow?.nodeId !== gateNodeId ||
          run.flow?.instance !== gateInstance || run.attempt?.instance !== gateInstance || run.attempt?.status !== 'waiting')
        throw new Error('The human gate is no longer the active workflow step.');
      const workflow = normalize(run.workflow);
      const gate = workflow.nodes.find(node => node.id === gateNodeId);
      const route = workflow.edges.find(edge => edge.from === gateNodeId && edge.to === targetNodeId && edge.outcome === 'approved');
      const target = workflow.nodes.find(node => node.id === targetNodeId);
      if (gate?.kind !== 'human' || !route || !target?.activity)
        throw new Error('The reservation target must be the configured approved activity route.');
      const descriptor = activityCatalog?.get(target.activity);
      if (!descriptor?.approval.required || descriptor.approval.policy !== 'workflow-gate')
        throw new Error('The target activity does not require a workflow approval reservation.');
      run.activityReservations = (run.activityReservations ?? []).filter(item =>
        !item.consumedAt && !item.invalidatedAt || item.id === run.attempt?.reservationId &&
          ['ready', 'running', 'waiting', 'uncertain'].includes(run.attempt?.status));
      const existing = run.activityReservations.find(item => item.gateInstance === gateInstance && item.targetNodeId === targetNodeId && !item.consumedAt && !item.invalidatedAt);
      if (existing) return structuredClone({ id: existing.id, digest: existing.digest, preview: existing.preview });
      if (run.activityReservations.filter(item => !item.consumedAt && !item.invalidatedAt).length >= 32)
        throw new Error('Workflow has too many outstanding activity reservations.');
      const targetInstance = randomUUID();
      const prepared = await prepareActivityIntent(run, target, targetInstance, { gateNodeId, gateInstance });
      if (activityDigest(prepared.ref) !== activityDigest(target.activity)) throw new Error('Prepared activity revision changed.');
      const reservation = {
        id: randomUUID(), runId, gateNodeId, gateInstance, targetNodeId, targetInstance,
        activityRef: structuredClone(prepared.ref), inputDigest: prepared.inputDigest,
        activityDescriptorDigest: target.activityDescriptorDigest ?? activityDigest(descriptor),
        intentDigest: prepared.intentDigest, idempotencyKey: prepared.idempotencyKey,
        intent: structuredClone(prepared.intent), preview: structuredClone(prepared.preview),
        digest: activityDigest({ runId, gateNodeId, gateInstance, targetNodeId, targetInstance,
          activityRef: prepared.ref, activityDescriptorDigest: target.activityDescriptorDigest ?? activityDigest(descriptor),
          inputDigest: prepared.inputDigest, intentDigest: prepared.intentDigest }),
        createdAt: new Date().toISOString(),
      };
      run.activityReservations.push(reservation);
      await save();
      return structuredClone({ id: reservation.id, digest: reservation.digest, preview: reservation.preview });
    },
    activityReservationForActivation(runContext, nodeId) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      const history = run?.flow?.history?.at(-1);
      if (!run || !history || history.outcome !== 'approved') return null;
      const reservation = (run.activityReservations ?? []).find(item => item.gateNodeId === history.nodeId &&
        item.gateInstance === history.instance && item.targetNodeId === nodeId && item.id === history.activityReservationId &&
        item.digest === history.activityReservationDigest && !item.consumedAt && !item.invalidatedAt);
      return reservation ? structuredClone(reservation) : null;
    },
    verifyActivityReservationDecision(runContext, { gateNodeId, gateInstance, targetNodeId, reservationId, reservationDigest }) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const reservation = (run.activityReservations ?? []).find(item => item.gateNodeId === gateNodeId && item.gateInstance === gateInstance &&
        item.targetNodeId === targetNodeId && !item.consumedAt && !item.invalidatedAt);
      const target = normalize(run.workflow).nodes.find(node => node.id === targetNodeId);
      const descriptor = target?.activity && activityCatalog?.get(target.activity);
      if (target?.activity && !descriptor) throw new Error('The pinned target activity revision is unavailable.');
      if (!reservation) {
        if (target?.activity && descriptor?.approval.required)
          throw new Error('Prepare and review the exact activity intent before approving this gate.');
        return null;
      }
      if (reservation.id !== reservationId || reservation.digest !== reservationDigest)
        throw new Error('Approve against the exact prepared activity reservation shown for this gate.');
      if (target?.activityDescriptorDigest && target.activityDescriptorDigest !== reservation.activityDescriptorDigest)
        throw new Error('The pinned activity metadata changed after this intent was prepared.');
      return { id: reservation.id, digest: reservation.digest, targetNodeId,
        activityRef: structuredClone(reservation.activityRef), inputDigest: reservation.inputDigest,
        intentDigest: reservation.intentDigest, preview: structuredClone(reservation.preview) };
    },
    activityReservationForAttempt(runContext, nodeId, instance) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      const attempt = run?.attempt;
      if (!run || attempt?.nodeId !== nodeId || attempt?.instance !== instance || !attempt.reservationId) return null;
      const reservation = (run.activityReservations ?? []).find(item => item.id === attempt.reservationId &&
        item.targetNodeId === nodeId && item.targetInstance === instance);
      const approved = (run.flow?.history ?? []).some(item => item.outcome === 'approved' &&
        item.activityReservationId === reservation?.id && item.activityReservationDigest === reservation?.digest);
      return reservation && approved ? structuredClone(reservation) : null;
    },
    invalidateActivityReservations(runContext, { gateNodeId, gateInstance }) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) return;
      for (const reservation of run.activityReservations ?? [])
        if (reservation.gateNodeId === gateNodeId && reservation.gateInstance === gateInstance && !reservation.consumedAt)
          reservation.invalidatedAt = new Date().toISOString();
    },
    resolveActivityInput(run, node) {
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const ref = this.getActivityRef(node);
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error(`${node.name}: pinned activity revision is unavailable.`);
      if (node.activity) return resolveActivityBindings(node.bindings ?? {}, descriptor.inputSchema, {
        runInputSchema: normalize(run.workflow).runInputSchema,
        runInput: run.runInput ?? {},
        activityOutputs: run.activityOutputs ?? {},
      });
      return structuredClone(node.input ?? {});
    },
    async recordActivityIntent(context, { instance, nodeId, ref, input, intent, idempotencyKey, reservationId, legacy = false, legacyCommand }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.flow?.instance !== instance || run.flow?.nodeId !== nodeId || run.attempt?.instance !== instance)
        throw new Error('Workflow activity changed before its intent was persisted.');
      const workflow = normalize(run.workflow);
      const pinnedNode = workflow.nodes.find(node => node.id === nodeId);
      if (!['ready', 'running'].includes(run.attempt.status) || run.flow?.status === 'cancelled')
        throw new Error('Workflow activity cannot persist an intent after the run was stopped.');
      const expectedRef = this.getActivityRef(pinnedNode);
      if (!pinnedNode || activityDigest(expectedRef) !== activityDigest(ref))
        throw new Error('Workflow activity reference does not match its pinned node.');
      if (idempotencyKey !== `${run.id}:${instance}`) throw new Error('Workflow activity idempotency identity is invalid.');
      const resolvedInput = this.resolveActivityInput(run, pinnedNode);
      if (activityDigest(resolvedInput) !== activityDigest(input)) throw new Error('Workflow activity input does not match its pinned bindings.');
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error('Pinned activity revision is unavailable.');
      const descriptorDigest = activityDigest(descriptor);
      if (pinnedNode.activityDescriptorDigest && pinnedNode.activityDescriptorDigest !== descriptorDigest ||
          run.attempt.activityRef && run.attempt.activityDescriptorDigest && run.attempt.activityDescriptorDigest !== descriptorDigest)
        throw new Error('Pinned activity metadata changed; execution is blocked.');
      const checkedInput = legacy ? structuredClone(input) : validateActivityValue(input, descriptor.inputSchema);
      if (Buffer.byteLength(JSON.stringify(intent ?? null)) > 16_000) throw new Error('Activity intent is too large.');
      const intentValue = structuredClone(intent ?? {});
      const inputDigest = activityDigest(checkedInput);
      const intentDigest = activityDigest(intentValue);
      const effectKey = `${run.id}:${instance}:${nodeId}`;
      const existing = run.attempt.intent;
      if (existing && (run.attempt.inputDigest !== inputDigest || run.attempt.intentDigest !== intentDigest ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref) || run.attempt.idempotencyKey !== idempotencyKey))
        throw new Error('Workflow activity already has a different persisted intent.');
      if (existing && ['completed', 'failed', 'uncertain', 'waiting', 'cancelled'].includes(run.attempt.status))
        throw new Error('Workflow activity attempt is not eligible to persist another dispatch intent.');
      const evidence = state.workflowEffectLedger?.[effectKey];
      const reservation = reservationId && (run.activityReservations ?? []).find(value => value.id === reservationId);
      if (reservationId && run.attempt.reservationId !== reservationId)
        throw new Error('Workflow activity reservation identity changed.');
      if (run.attempt.reservationId && (!reservation || reservation.id !== run.attempt.reservationId || reservation.targetInstance !== instance ||
          reservation.targetNodeId !== nodeId || activityDigest(reservation.activityRef) !== activityDigest(ref) ||
          reservation.activityDescriptorDigest !== activityDigest(descriptor) ||
          reservation.inputDigest !== inputDigest || reservation.intentDigest !== intentDigest || reservation.idempotencyKey !== idempotencyKey))
        throw new Error('Workflow activity does not match its prepared approval reservation.');
      if (reservation && reservation.consumedAt && (!existing || run.attempt.reservationId !== reservation.id))
        throw new Error('Workflow activity reservation has already been consumed.');
      if (evidence && ((evidence.inputDigest && evidence.inputDigest !== inputDigest) ||
          (evidence.activityRef && activityDigest(evidence.activityRef) !== activityDigest(ref)) ||
          (evidence.intentDigest && evidence.intentDigest !== intentDigest) ||
          (evidence.idempotencyKey && evidence.idempotencyKey !== idempotencyKey)))
        throw new Error('Workflow effect identity does not match its persisted attempt.');
      run.attempt.activityRef = structuredClone(ref);
      run.attempt.activityDescriptorDigest = descriptorDigest;
      run.attempt.inputDigest = inputDigest;
      run.attempt.intentDigest = intentDigest;
      run.attempt.intent = intentValue;
      run.attempt.idempotencyKey = idempotencyKey;
      run.attempt.effectKey = effectKey;
      run.attempt.effect = descriptor.effect;
      if (legacy) run.attempt.legacyAction = true;
      if (reservation) reservation.consumedAt = new Date().toISOString();
      run.attempt.status = 'ready';
      run.attempt.dispatchStarted = false;
      state.workflowEffectLedger ??= {};
      if (descriptor.effect === 'durable-effect' && !evidence) state.workflowEffectLedger[effectKey] = {
        at: new Date().toISOString(), status: 'prepared', operation: legacyCommand?.operation ?? ref.id,
        sessionId: run.sessionId, projectId: run.projectId, organizationId: run.organizationId,
        ...((intentValue?.command || legacyCommand) ? { command: structuredClone(intentValue?.command ?? legacyCommand) } : {}), activityRef: structuredClone(ref),
        inputDigest, intentDigest: run.attempt.intentDigest, idempotencyKey,
      };
      else if (descriptor.effect === 'durable-effect' && evidence && ['prepared', 'pending'].includes(evidence.status)) {
        Object.assign(evidence, { intentDigest, idempotencyKey, status: 'prepared' });
        delete evidence.message;
        delete evidence.blockingReplyRequestId;
        delete evidence.blockingReplyStatus;
      }
      await save();
      return effectKey;
    },
    async markActivityDispatchStarted(context, { instance, nodeId, ref }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref) || !run.attempt.intent)
        throw new Error('Workflow activity changed before dispatch started.');
      if (run.attempt.status !== 'ready') throw new Error('Workflow activity is not ready to dispatch.');
      run.attempt.dispatchStarted = true;
      run.attempt.status = 'running';
      const effect = state.workflowEffectLedger?.[run.attempt.effectKey];
      if (effect?.status === 'prepared') effect.status = 'pending';
      await save();
    },
    async markActivityResourceWait(context, { instance, nodeId, status = 'waiting' }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          !['ready', 'running'].includes(run.attempt.status) || run.attempt.dispatchStarted === true)
        throw new Error('Workflow activity cannot wait for resources after dispatch may have started.');
      if (!['ready', 'waiting'].includes(status)) throw new Error('Unsupported workflow resource-wait status.');
      run.attempt.status = status;
      await save();
    },
    async resetActivityBeforeDispatch(context, { instance, nodeId, ref, message }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref))
        throw new Error('Workflow activity cannot be reset after dispatch may have started.');
      run.attempt.dispatchStarted = false;
      run.attempt.status = 'failed';
      run.attempt.message = String(message ?? 'Activity was cancelled before dispatch.').slice(0, 1000);
      const effect = state.workflowEffectLedger?.[run.attempt.effectKey];
      if (effect?.status === 'pending') effect.status = 'prepared';
      await save();
    },
    async recordActivityResult(context, { instance, nodeId, ref, output, status = 'completed', message, evidence, expectedWaitingOutputDigest, reconciliation = false, dispatchReceipt = false }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId)
        throw new Error('Workflow activity changed before its result was recorded.');
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error('Pinned activity revision is unavailable.');
      if (activityDigest(run.attempt.activityRef) !== activityDigest(ref)) throw new Error('Activity result revision does not match the persisted intent.');
      if (!['completed', 'waiting', 'failed', 'uncertain'].includes(status)) throw new Error('Unsupported activity result state.');
      if (run.attempt.outputDigest) {
        if (status !== 'completed') throw new Error('A completed activity receipt cannot change state.');
        const duplicate = validateActivityValue(output, descriptor.outputSchema);
        if (run.attempt.outputDigest !== activityDigest(duplicate))
          throw new Error('Activity result is immutable once recorded.');
        return;
      }
      const priorStatus = run.attempt.status;
      if (run.attempt.status === 'failed' && status !== 'failed' ||
          run.attempt.status === 'cancelled' && !(status === 'completed' && dispatchReceipt || status === 'waiting' && reconciliation) ||
          run.attempt.status === 'uncertain' && status !== 'uncertain' && !reconciliation && !dispatchReceipt)
        throw new Error('A terminal activity attempt cannot be changed by a late callback.');
      if (run.attempt.status === 'failed' && status === 'failed') {
        const safeMessage = message ? String(message).slice(0, 1000) : undefined;
        if (run.attempt.message !== safeMessage) throw new Error('A failed activity receipt is immutable once recorded.');
        return;
      }
      if (status === 'completed') {
        const checked = validateActivityValue(output, descriptor.outputSchema);
        const outputDigest = activityDigest(checked);
        run.attempt.outputDigest = outputDigest;
        run.attempt.output = checked;
        run.attempt.status = 'completed';
        run.activityOutputs ??= {};
        run.activityOutputs[nodeId] = { status: 'completed', activityRef: structuredClone(ref), schema: structuredClone(descriptor.outputSchema), value: checked, digest: outputDigest, instance };
        const key = run.attempt.effectKey;
        if (key && state.workflowEffectLedger?.[key]) Object.assign(state.workflowEffectLedger[key], { status: 'succeeded', result: structuredClone(checked), outputDigest });
      } else if (status === 'waiting') {
        const checked = validateActivityValue(output, descriptor.outputSchema);
        const outputDigest = activityDigest(checked);
        if (run.attempt.waitingOutputDigest && (expectedWaitingOutputDigest !== run.attempt.waitingOutputDigest ||
            run.attempt.waitingOutputDigest !== activityDigest(run.attempt.waitingOutput)))
          throw new Error('Waiting activity observation changed before confirmation.');
        if (!run.attempt.waitingOutputDigest && expectedWaitingOutputDigest !== undefined)
          throw new Error('Waiting activity observation is no longer current.');
        if (run.attempt.waitingOutputDigest && run.attempt.waitingOutputDigest !== outputDigest) {
          run.attempt.waitingHistory ??= [];
          if (run.attempt.waitingHistory.length < 8) run.attempt.waitingHistory.push({ digest: run.attempt.waitingOutputDigest, at: new Date().toISOString() });
        }
        run.attempt.waitingOutput = checked;
        run.attempt.waitingOutputDigest = outputDigest;
        if (evidence?.workPreDispatch === true) {
          run.attempt.dispatchStarted = false;
          run.attempt.waitingEvidence = { workPreDispatch: true,
            ...(typeof evidence.blockingReplyRequestId === 'string' ? { blockingReplyRequestId: evidence.blockingReplyRequestId.slice(0, 300) } : {}),
            ...(typeof evidence.blockingReplyStatus === 'string' ? { blockingReplyStatus: evidence.blockingReplyStatus.slice(0, 80) } : {}) };
        }
        run.attempt.status = priorStatus === 'cancelled' ? 'cancelled' : 'waiting';
        const key = run.attempt.effectKey;
        if (key && state.workflowEffectLedger?.[key]) {
          state.workflowEffectLedger[key].status = evidence?.workPreDispatch === true ? 'blocked' : 'pending';
          state.workflowEffectLedger[key].result = structuredClone(checked);
          state.workflowEffectLedger[key].outputDigest = outputDigest;
          if (evidence && typeof evidence === 'object') {
            for (const field of ['blockingReplyRequestId', 'blockingReplyStatus'])
              if (typeof evidence[field] === 'string') state.workflowEffectLedger[key][field] = evidence[field].slice(0, 300);
          }
        }
      } else {
        run.attempt.status = status;
        if (message) run.attempt.message = String(message).slice(0, 1000);
        const key = run.attempt.effectKey;
        if (status === 'failed' && evidence?.workPreDispatch === true && output !== undefined) {
          const checked = validateActivityValue(output, descriptor.outputSchema);
          run.attempt.dispatchStarted = false;
          run.attempt.waitingOutput = checked;
          run.attempt.waitingOutputDigest = activityDigest(checked);
          run.attempt.waitingEvidence = { workPreDispatch: true,
            ...(typeof evidence.blockingReplyRequestId === 'string' ? { blockingReplyRequestId: evidence.blockingReplyRequestId.slice(0, 300) } : {}),
            ...(typeof evidence.blockingReplyStatus === 'string' ? { blockingReplyStatus: evidence.blockingReplyStatus.slice(0, 80) } : {}) };
        }
        if (key && state.workflowEffectLedger?.[key]) {
          state.workflowEffectLedger[key].status = status === 'uncertain' ? 'uncertain' : status === 'failed' ? 'blocked' : 'pending';
          if (run.attempt.waitingEvidence?.workPreDispatch && key)
            Object.assign(state.workflowEffectLedger[key], run.attempt.waitingEvidence);
          if (run.attempt.waitingOutputDigest) {
            state.workflowEffectLedger[key].result = structuredClone(run.attempt.waitingOutput);
            state.workflowEffectLedger[key].outputDigest = run.attempt.waitingOutputDigest;
          }
          if (message) state.workflowEffectLedger[key].message = String(message).slice(0, 1000);
        }
      }
      await save();
    },
    async reconcileActivityAttempt(context, { instance, nodeId, ref, state: resolution, output, message }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref))
        throw new Error('Workflow activity changed before reconciliation was recorded.');
      if (!['applied', 'not_applied', 'unknown', 'waiting'].includes(resolution)) throw new Error('Unsupported adapter reconciliation state.');
      const key = run.attempt.effectKey;
      if (run.attempt.outputDigest && resolution !== 'applied') throw new Error('A completed activity receipt cannot be reconciled away.');
      if (run.attempt.status === 'failed' && run.attempt.dispatchStarted === false && resolution !== 'not_applied')
        throw new Error('A proven not-dispatched failure cannot be reconciled as applied.');
      if (resolution === 'applied') {
        await this.recordActivityResult(context, { instance, nodeId, ref, output, status: 'completed', reconciliation: true });
      } else if (resolution === 'waiting') {
        await this.recordActivityResult(context, { instance, nodeId, ref, output, status: 'waiting', message, reconciliation: true,
          ...(run.attempt.waitingOutputDigest ? { expectedWaitingOutputDigest: run.attempt.waitingOutputDigest } : {}) });
      } else {
        if (run.attempt.outputDigest) throw new Error('A completed activity receipt cannot be reconciled away.');
        run.attempt.status = resolution === 'not_applied' ? 'ready' : 'uncertain';
        if (resolution === 'not_applied') {
          run.attempt.dispatchStarted = false;
          delete run.attempt.waitingOutput;
          delete run.attempt.waitingOutputDigest;
          delete run.attempt.waitingHistory;
        }
        if (message) run.attempt.message = String(message).slice(0, 1000);
        const evidence = key && state.workflowEffectLedger?.[key];
        if (evidence) {
          evidence.status = resolution === 'not_applied' ? 'prepared' : 'uncertain';
          evidence.reconciledAt = new Date().toISOString();
          evidence.resolution = resolution;
          if (message) evidence.message = String(message).slice(0, 1000);
        }
        await save();
      }
    },
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
        if (run.attempt?.instance && run.attempt?.nodeId) {
          const key = `${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`;
          const effect = state.workflowEffectLedger?.[key];
          if (effect) {
            run.attempt.effectKey ??= key;
            if (!run.attempt.activityRef && effect.result && run.attempt.effectResult === undefined)
              run.attempt.effectResult = structuredClone(effect.result);
          }
        }
        if (run.independentRun && ['reserved', 'running'].includes(run.assignment?.state)) {
          run.assignment.state = 'uncertain';
          run.assignment.message = 'Daemon restarted while this workflow run held runner resources. Inspect the original runner before reuse.';
        }
        if (run.independentRun && run.flow?.status === 'running' && run.attempt?.status === 'completed' && run.attempt.outputDigest) {
          // The immutable receipt survived, but its graph transition did not.
          // Explicit continue re-enters the cached-output path without dispatch.
          run.flow.resumeStatus = 'ready';
          run.flow.status = 'interrupted';
          run.status = 'interrupted';
        }
        if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
          const safelyRecomputable = ['pure', 'observation'].includes(run.attempt.effect);
          const mayHaveDispatched = run.attempt.dispatchStarted === true || run.attempt.dispatchStarted === undefined;
          run.attempt.status = !safelyRecomputable && mayHaveDispatched ? 'uncertain' : 'ready';
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
      session.workflow = normalize(run.workflow);
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
  const safeAttempt = attempt => attempt && ({
    instance: attempt.instance, nodeId: attempt.nodeId, status: attempt.status,
    startedAt: attempt.startedAt, completedAt: attempt.completedAt, outcome: attempt.outcome,
    ...(attempt.activityRef ? { activityRef: structuredClone(attempt.activityRef) } : {}),
    ...(attempt.effect ? { effect: attempt.effect } : {}),
    ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
    ...(attempt.inputDigest ? { inputDigest: attempt.inputDigest } : {}),
    ...(attempt.outputDigest ? { outputDigest: attempt.outputDigest } : {}),
    ...(attempt.message ? { message: attempt.message } : {}),
    ...(attempt.effectKey ? { effectKey: attempt.effectKey } : {}),
    ...((attempt.legacyAction || !attempt.activityRef) && attempt.effectResult ? { effectResult: structuredClone(attempt.effectResult) } : {}),
  });
  return {
    id: run.id, organizationId: run.organizationId, projectId: run.projectId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}), independent: Boolean(run.independentRun),
    workflowId: run.flow?.workflowId, workflowVersion: run.flow?.workflowVersion,
    status: run.flow?.status ?? run.status, nodeId: run.flow?.nodeId,
    instance: run.flow?.instance, activeTicketId: run.activeTicketId ?? run.ticketId,
    startedAt: run.flow?.startedAt ?? run.startedAt, updatedAt: run.updatedAt ?? run.flow?.history?.at(-1)?.at ?? run.flow?.startedAt ?? run.startedAt,
    ...(run.runInputDigest ? { runInputDigest: run.runInputDigest } : {}),
    ...(run.resultDigest ? { resultDigest: run.resultDigest } : {}),
    ...(() => {
      const reservation = [...(run.activityReservations ?? [])].reverse().find(value =>
        value.gateNodeId === run.flow?.nodeId && value.gateInstance === run.flow?.instance && !value.consumedAt && !value.invalidatedAt);
      return reservation ? { activityReservations: [{ id: reservation.id, gateNodeId: reservation.gateNodeId,
        gateInstance: reservation.gateInstance, targetNodeId: reservation.targetNodeId, targetInstance: reservation.targetInstance,
        activityRef: structuredClone(reservation.activityRef), inputDigest: reservation.inputDigest, intentDigest: reservation.intentDigest,
        digest: reservation.digest }] } : {};
    })(),
    attempt: safeAttempt(run.attempt), activityAttempts: [...(run.activityAttempts ?? []).slice(-50).map(safeAttempt), ...(run.attempt ? [safeAttempt(run.attempt)] : [])],
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
