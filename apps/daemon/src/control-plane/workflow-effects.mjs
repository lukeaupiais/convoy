import { workflowActionInput, activityDigest, workflowEventPath } from '../modules/workflows/index.mjs';
import { createWorkflowActivityImplementationMap, activityRefForNode } from './workflow-activity-adapters.mjs';

export function migrateWorkflowEffectState(state) {
  state.automationDecisionLedger ??= {};
  state.automationFailures ??= [];
  state.automationFailures = state.automationFailures.slice(-100);
}

/**
 * Owns every workflow side effect that can mutate board state. The ledger is
 * written before mutation so restarts fail closed instead of replaying an
 * uncertain create/update/move.
 */
export function createWorkflowEffects({ state, catalog, conversations, sessionFor, boards, workCommand, workEvidence,
  latestDeliveredReply, workReplyConfirmation, inspectChanges, makeSession, pinInstructions,
  event, save, now, getEngine, requireText, authorizeStart, activityCatalog, injectedActivities = [],
  getWorkflowOwner = () => null, authorizeActivity = async () => {}, workEventOutbox, processEventDecisions = async () => {} }) {
  migrateWorkflowEffectState(state);
  const activityImplementations = createWorkflowActivityImplementationMap({ workCommand, workEvidence,
    latestDeliveredReply, workReplyConfirmation, catalog, state, inspectChanges, injected: injectedActivities });
  const effectRecord = key => getWorkflowOwner()?.effectRecord(key) ?? null;
  const saveEffect = (key, value) => getWorkflowOwner()?.saveEffectRecord(key, value);
  const deleteEffect = key => getWorkflowOwner()?.deleteEffectRecord(key);
  async function boardCommand(command, session) {
    const result = workCommand
      ? await workCommand(command, session)
      : await (boards?.command ?? catalog.command)(command);
    return observeBoardCommand(command, result);
  }

  async function observeBoardCommand(command, result) {
    // Work has durably queued its canonical fact before this coordinator hook.
    await drainWorkFacts();
    return result;
  }
  async function acceptWorkFact(fact) {
    const owner = getWorkflowOwner();
    if (!owner || !workEventOutbox) return;
    const run = fact.causation?.runId ? owner.run(fact.causation.runId) : null;
    const parent = run?.provenance;
    const envelope = {
      descriptor: { id: `work.${fact.event}`, revision: 1 },
      source: { id: fact.sourceId, eventId: fact.sourceEventId },
      organizationId: fact.organizationId, projectId: fact.projectId,
      payload: fact.payload,
      ...(() => {
        const descriptor = owner.eventJournal.descriptor({ id: `work.${fact.event}`, revision: 1 });
        const key = descriptor?.correlationPaths?.[0];
        const value = key && workflowEventPath(fact.payload, key);
        return value === undefined ? {} : { correlation: { key, value: String(value) } };
      })(),
      ...(fact.causation ? { causation: {
        eventId: parent?.eventId ?? `run:${fact.causation.runId}`,
        runId: fact.causation.runId,
        depth: (parent?.causation?.depth ?? 0) + 1,
        rootEventId: parent?.causation?.rootEventId ?? parent?.eventId ?? `run:${fact.causation.runId}`,
      } } : {}),
    };
    const disposition = await owner.acceptOutboxEvent(envelope);
    if (disposition.rejected) {
      // The Work fact may be acknowledged only after Workflow has durably
      // recorded this known terminal cascade disposition. Other failures stay
      // pending so they remain visible and retryable.
      await workEventOutbox.acknowledge(fact.kind, fact.key);
      return;
    }
    await processEventDecisions();
    await owner.deliverPendingWaitEvents?.();
    await workEventOutbox.acknowledge(fact.kind, fact.key);
  }

  async function drainWorkFacts() {
    if (!workEventOutbox) return;
    for (const fact of workEventOutbox.pending(500)) await acceptWorkFact(fact);
  }

  async function drainImportFacts() { await drainWorkFacts(); }

  async function sendApprovedReply(session, node, instance) {
    const approval = session.flow.approvedSubmission;
    const input = node.input;
    const body = approval?.submission?.details?.[input.field];
    const reviewed = session.flow.history.some(entry => entry.nodeId === approval?.reviewNodeId &&
      entry.instance === approval?.reviewInstance && entry.outcome === 'approved' && entry.to === node.id);
    if (!reviewed || approval.submission.nodeId !== input.sourceNodeId || typeof body !== 'string' || !body.trim())
      throw new Error('No approved captured reply is available for this action.');
    const ticketId = session.activeTicketId;
    const expectedCommand = { action: 'postExternalTicketReply', ticketId, connectionId: input.connectionId, body,
      requestId: `reply-${session.flow.id}-${instance}`, workflowRunId: session.flow.id, workflowInstance: instance };
    const effectKey = `${session.flow.id}:${instance}:${node.id}`;
    let effect = effectRecord(effectKey);
    if (effect && !['succeeded', 'blocked'].includes(effect.status))
      throw new Error('Reply send has an uncertain outcome. Reconcile the existing reply before retrying.');
    const command = effect?.status === 'blocked' ? effect.command : expectedCommand;
    if (!command || command.action !== expectedCommand.action || command.ticketId !== expectedCommand.ticketId ||
        command.connectionId !== expectedCommand.connectionId || command.body !== expectedCommand.body ||
        command.requestId !== expectedCommand.requestId || command.workflowRunId !== expectedCommand.workflowRunId ||
        command.workflowInstance !== expectedCommand.workflowInstance)
      throw new Error('The recorded approved reply identity no longer matches this workflow step.');
    if (!effect) {
      effect = { at: now(), status: 'pending', operation: node.operation,
        sessionId: session.id, projectId: session.projectId, command: structuredClone(command) };
      saveEffect(effectKey, effect);
      await save();
    }
    if (effect.status !== 'succeeded') {
      try {
        effect.result = structuredClone(await boardCommand(command, session));
        effect.status = 'succeeded';
        delete effect.message;
        delete effect.blockingReplyRequestId;
        delete effect.blockingReplyStatus;
        saveEffect(effectKey, effect);
        await save();
      } catch (error) {
        if (error?.code === 'TICKET_REPLY_UNRESOLVED' && error?.outcome === 'not-dispatched' &&
            typeof error.blockingReplyRequestId === 'string') {
          effect.status = 'blocked';
          effect.message = error.message;
          effect.blockingReplyRequestId = error.blockingReplyRequestId;
          effect.blockingReplyStatus = error.blockingReplyStatus;
        } else {
          effect.status = 'uncertain'; effect.message = error.message;
        }
        saveEffect(effectKey, effect);
        await save(); throw error;
      }
    }
    const thread = await boardCommand({ action: 'syncExternalTicketThread', ticketId, connectionId: input.connectionId }, session);
    const reply = state.ticketReplies.find(reply => reply.id === command.requestId && reply.ticketId === ticketId &&
      reply.connectionId === input.connectionId && reply.body === body && reply.workflowRunId === session.flow.id);
    const delivered = thread.messages.some(message => message.remoteId === reply?.remoteId && message.body === body &&
      message.direction === 'outbound' && message.deliveryStatus === 'delivered');
    if (reply?.status !== 'queued' || !delivered)
      return { awaitingDelivery: true, replyRequestId: command.requestId, deliveryStatus: reply?.deliveryStatus ?? 'pending',
        message: 'Approved reply sent; delivery is not confirmed. Continue to check delivery without resending.' };
    return structuredClone(reply);
  }

  async function executeLegacyAction(session, node, instance) {
    if (node.operation === 'inspect_changes') return null;
    if (node.operation === 'send_external_reply') return sendApprovedReply(session, node, instance);
    if (!['create_ticket', 'create_related_ticket', 'update_ticket', 'move_ticket', 'set_external_status'].includes(node.operation)) throw new Error('Unsupported workflow action.');
    const payload = workflowActionInput(node);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Workflow action arguments must be an object.');
    const command = { ...payload, workflowRunId: session.flow.id, workflowInstance: instance, idempotencyKey: `${session.flow.id}:${instance}` };
    if (command.ticketSource === 'last_created') {
      const id = session.flow.ticketBindings?.last_created ?? session.flow.actionResult?.id ?? session.flow.actionResult?.ticketId;
      if (id === undefined) throw new Error('No ticket was created by an earlier workflow action.');
      command.ticketId = id;
    }
    delete command.ticketSource;
    if (command.taskId === undefined && session.activeTicketId != null) command.taskId = session.activeTicketId;
    if (node.operation === 'create_ticket') command.action = 'createTicket';
    else if (node.operation === 'create_related_ticket') {
      const source = catalog.ticket(command.sourceTicketId ?? session.activeTicketId);
      if (!source || source.projectId !== session.projectId) throw new Error('Active ticket is unavailable.');
      command.action = 'createRelatedTicket';
      command.sourceTicketId = source.id;
      command.sourceRevision = source.revision;
    }
    else if (node.operation === 'update_ticket') { command.action = 'updateTicket'; command.taskId ??= command.ticketId; command.requestId ??= command.requestKey ?? `${session.flow.id}-${instance}`; }
    else if (node.operation === 'set_external_status') {
      command.action = 'setExternalTicketStatus';
      command.ticketId ??= session.activeTicketId;
      command.requestId ??= command.requestKey ?? `${session.flow.id}-${instance}`;
      if (command.evidenceReply === 'latest_delivered') {
        await boardCommand({ action: 'syncExternalTicketThread', ticketId: command.ticketId, connectionId: command.connectionId }, session);
        const candidates = (state.ticketReplies ?? []).filter(reply =>
          reply.ticketId === command.ticketId && reply.connectionId === command.connectionId &&
          reply.status === 'queued' && reply.deliveryStatus === 'delivered' &&
          reply.workflowRunId === session.flow.id);
        const latest = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!latest) throw new Error('No delivered reply from this workflow run was found.');
        command.evidenceReplyRequestId = latest.id;
      }
      delete command.evidenceReply;
    }
    else { command.action = 'setBoardPlacement'; command.ticketId ??= command.taskId ?? session.activeTicketId; }
    const target = command.ticketId ?? command.taskId;
    if (target !== undefined && command.revision === undefined) command.revision = catalog.ticket(target)?.revision;
    if (['create_ticket', 'create_related_ticket'].includes(node.operation)) command.requestId ??= command.requestKey ?? `${session.flow.id}-${instance}`;
    const effectKey = `${session.flow.id}:${instance}:${node.id}`;
    const previous = effectRecord(effectKey);
    if (previous) {
      if (previous.status === 'succeeded') return structuredClone(previous.result);
      throw new Error('Workflow board effect has an uncertain outcome. Inspect the board before retrying this step.');
    }
    const effect = {
      at: now(),
      status: 'pending',
      operation: node.operation,
      sessionId: session.id,
      projectId: session.projectId,
      organizationId: state.projects.find((project) => project.id === session.projectId)?.organizationId,
      command: structuredClone(command),
    };
    saveEffect(effectKey, effect);
    await save();
    try {
      const result = await boardCommand(command, session);
      if (['create_ticket', 'create_related_ticket'].includes(node.operation) && result?.id !== undefined) { session.flow.ticketBindings ??= {}; session.flow.ticketBindings.last_created = result.id; }
      saveEffect(effectKey, {
        ...effect,
        status: 'succeeded',
        result: structuredClone(result),
      });
      await save();
      return result;
    } catch (error) {
      effect.status = 'uncertain'; effect.message = error.message; saveEffect(effectKey, effect);
      await save();
      throw error;
    }
  }

  async function executeRegisteredActivity(session, node, instance, signal) {
    const owner = getWorkflowOwner();
    if (!owner) throw new Error('Workflow activity owner is unavailable.');
    const run = session?.independentRun ? session : owner.run(session?.workflowRunId ?? session?.flow?.id);
    if (!run) throw new Error('Workflow run is unavailable.');
    const ref = activityRefForNode(node);
    const descriptor = owner.activityDescriptor(ref);
    const key = `${ref?.id}@${ref?.revision}`;
    const implementation = activityImplementations.get(key);
    if (!descriptor || !implementation) throw new Error(`Pinned activity ${key} is unavailable.`);
    if (node.activityDescriptorDigest && activityDigest(descriptor) !== node.activityDescriptorDigest)
      throw new Error(`Pinned activity ${key} metadata changed; this run is blocked.`);
    const input = owner.resolveActivityInput(run, node);
    const identity = { runId: run.id, organizationId: run.organizationId, projectId: run.projectId,
      principal: structuredClone(run.principal), nodeId: node.id, instance,
      idempotencyKey: `${run.id}:${instance}` };
    const reservation = owner.activityReservationForActivation(session ?? run, node.id) ??
      owner.activityReservationForAttempt(run, node.id, instance);
    // A standalone run is the workflow owner, not a provider session. Sessionless
    // activities must see null here; linked runs arrive through their real session.
    const context = { run, session: session?.independentRun ? null : session, node, instance, signal, owner,
      ...(reservation ? { activityReservation: reservation } : {}) };
    const authorization = await authorizeActivity(run, descriptor, node, reservation, {
      phase: run.attempt?.dispatchStarted || run.attempt?.outputDigest ? 'confirm' : 'dispatch',
    });
    if (authorization?.model) context.model = authorization.model;
    if (run.attempt?.instance !== instance || run.attempt?.nodeId !== node.id)
      throw new Error('Workflow activity attempt changed before dispatch.');
    if (run.attempt.outputDigest) return structuredClone(run.attempt.output);
    if (run.attempt.status === 'uncertain') throw new Error('Workflow activity outcome is uncertain. Reconcile it before continuing.');

    if (run.attempt.waitingOutput) {
      if (typeof implementation.confirm !== 'function') throw new Error('Waiting activity requires adapter confirmation or reconciliation.');
      const confirmation = await implementation.confirm(context, input, { command: run.attempt.intent?.command, ...structuredClone(run.attempt.intent) });
      if (!confirmation) throw new Error('Waiting activity has no confirmation adapter.');
      if (confirmation.state === 'retry') {
        await owner.reconcileActivityAttempt(session, { instance, nodeId: node.id, ref, state: 'not_applied',
          message: 'Work proved the previous attempt was not dispatched.' });
        return executeRegisteredActivity(session, node, instance, signal);
      }
      if (confirmation.state === 'waiting') {
        await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'waiting', output: confirmation.output,
          evidence: confirmation.evidence, expectedWaitingOutputDigest: run.attempt.waitingOutputDigest });
        return { activityWaiting: true, output: structuredClone(confirmation.output) };
      }
      if (confirmation.state === 'failed') {
        await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'failed', message: confirmation.message ?? 'Work confirmed the activity failed.' });
        throw new Error(confirmation.message ?? 'Work confirmed the activity failed.');
      }
      if (confirmation.state !== 'completed') {
      await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'uncertain', message: confirmation.message ?? 'Activity confirmation is uncertain.', dispatchReceipt: true });
        throw new Error(confirmation.message ?? 'Activity confirmation is uncertain. Reconcile it before continuing.');
      }
      await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'completed', output: confirmation.output, dispatchReceipt: true });
      return confirmation.output;
    }

    if (run.attempt.intent && run.attempt.effect === 'durable-effect' && run.attempt.status === 'running' && run.attempt.dispatchStarted)
      throw new Error('Workflow activity has an unfinished dispatch. Reconcile it before continuing.');
    if (run.attempt.intent && run.attempt.status !== 'ready' && run.attempt.status !== 'running')
      throw new Error('Workflow activity is not eligible for dispatch.');
    const isLegacy = !node.activity;
    const intent = run.attempt.intent ?? (reservation ? structuredClone(reservation.intent) : await implementation.prepare(input, identity, context));
    await owner.recordActivityIntent(session, { instance, nodeId: node.id, ref, input, intent,
      idempotencyKey: identity.idempotencyKey, reservationId: run.attempt.reservationId, legacy: isLegacy,
      ...(isLegacy ? { legacyCommand: { operation: node.operation } } : {}) });
    if (signal?.aborted) {
      await owner.resetActivityBeforeDispatch(session, { instance, nodeId: node.id, ref, message: 'Activity stopped before dispatch.' });
      throw new Error('Workflow activity stopped.');
    }
    await owner.markActivityDispatchStarted(session, { instance, nodeId: node.id, ref });
    if (signal?.aborted) {
      await owner.resetActivityBeforeDispatch(session, { instance, nodeId: node.id, ref, message: 'Activity stopped before dispatch.' });
      throw new Error('Workflow activity stopped.');
    }
    let result;
    try {
      result = await implementation.dispatch(context, input, run.attempt.intent, signal);
      if (!result || !['completed', 'waiting', 'failed'].includes(result.state))
        throw new Error('Activity adapter returned an invalid result state.');
    } catch (error) {
      await owner.recordActivityResult(session, { instance, nodeId: node.id, ref,
        status: descriptor.effect === 'pure' ? 'failed' : 'uncertain', message: error.message, dispatchReceipt: true });
      throw error;
    }
    if (result.state === 'completed') {
      await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'completed', output: result.output, dispatchReceipt: true });
      return structuredClone(result.output);
    }
    if (result.state === 'waiting') {
      await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'waiting', output: result.output, message: result.message, evidence: result.evidence, dispatchReceipt: true });
      return { activityWaiting: true, output: result.output };
    }
    const failure = new Error(result.message ?? 'Activity failed before dispatch.');
    await owner.recordActivityResult(session, { instance, nodeId: node.id, ref, status: 'failed', message: failure.message,
      ...(result.output !== undefined ? { output: result.output } : {}), ...(result.evidence ? { evidence: result.evidence } : {}), dispatchReceipt: true });
    throw failure;
  }

  async function prepareActivityIntent(run, node, instance, approvalReservation = null) {
    const owner = getWorkflowOwner();
    const ref = activityRefForNode(node);
    const descriptor = owner?.activityDescriptor(ref);
    const implementation = activityImplementations.get(`${ref?.id}@${ref?.revision}`);
    if (!owner || !descriptor || !implementation) throw new Error('Pinned activity revision is unavailable.');
    if (node.activityDescriptorDigest && activityDigest(descriptor) !== node.activityDescriptorDigest)
      throw new Error('Pinned activity metadata changed; preparation is blocked.');
    if (run.attempt?.activityRef && activityDigest(run.attempt.activityRef) === activityDigest(ref) &&
        run.attempt.activityDescriptorDigest && run.attempt.activityDescriptorDigest !== activityDigest(descriptor))
      throw new Error('Pinned activity metadata changed; preparation is blocked.');
    const input = owner.resolveActivityInput(run, node, approvalReservation?.responseId ? { responseId: approvalReservation.responseId } : undefined);
    const identity = { runId: run.id, organizationId: run.organizationId, projectId: run.projectId,
      principal: structuredClone(run.principal), nodeId: node.id, instance, idempotencyKey: `${run.id}:${instance}` };
    const sourceRef = run.flow?.decisionSubmissionRef;
    const sourceEntry = sourceRef && run.flow?.history?.find(value => value.nodeId === sourceRef.nodeId &&
      value.instance === sourceRef.instance && value.to === approvalReservation?.gateNodeId);
    const submission = sourceEntry?.submission ? structuredClone(sourceEntry.submission) : undefined;
    if (submission && Buffer.byteLength(JSON.stringify(submission)) > 16_000)
      throw new Error('Captured submission is too large for resource-independent activity preparation.');
    const runContext = {
      id: run.id,
      organizationId: run.organizationId,
      projectId: run.projectId,
      principal: structuredClone(run.principal),
      ...(run.activeTicketId != null ? { activeTicketId: run.activeTicketId } : {}),
      ...(run.ticketId != null ? { ticketId: run.ticketId } : {}),
      flow: {
        status: run.flow?.status,
        nodeId: run.flow?.nodeId,
        instance: run.flow?.instance,
        ...(run.flow?.decisionSubmissionRef ? { decisionSubmissionRef: structuredClone(run.flow.decisionSubmissionRef) } : {}),
        ...(sourceEntry ? { history: [{
          nodeId: sourceEntry.nodeId, instance: sourceEntry.instance, to: sourceEntry.to, outcome: sourceEntry.outcome,
          ...(submission ? { submission } : {}),
        }] } : {}),
        ...(run.flow?.ticketBindings?.last_created != null ? { ticketBindings: { last_created: run.flow.ticketBindings.last_created } } : {}),
      },
    };
    const context = { run: runContext, session: null, node: structuredClone(node), instance,
      ...(approvalReservation ? { activityReservation: structuredClone(approvalReservation) } : {}) };
    // Preparation computes a bounded immutable intent for review. It must not
    // allocate the node's provider, runner, or workspace resources; dispatch
    // rechecks all active grants after that node becomes active.
    const authorization = await authorizeActivity(run, descriptor, node, approvalReservation, { phase: 'prepare' });
    if (authorization?.model) context.model = authorization.model;
    const intent = await implementation.prepare(input, identity, context);
    if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Buffer.byteLength(JSON.stringify(intent)) > 16_000)
      throw new Error('Activity adapter prepared an invalid or oversized intent.');
    // Approval sees the exact validated values and deterministic prepared effect
    // that will be consumed at activation. Never infer review material from a
    // particular command shape or silently truncate a payload.
    const resourcePins = authorization?.resourcePins ?? {};
    const preview = { activity: descriptor.presentation.label, input: structuredClone(input), intent: structuredClone(intent),
      ...(Object.keys(resourcePins).length ? { resources: structuredClone(resourcePins) } : {}) };
    if (Buffer.byteLength(JSON.stringify(preview)) > 24_000) throw new Error('Activity approval material is too large to review safely.');
    return { ref: structuredClone(ref), input, inputDigest: activityDigest(input), intent: structuredClone(intent),
      intentDigest: activityDigest(intent), idempotencyKey: identity.idempotencyKey,
      resourcePins, preview };
  }

  async function executeAction(session, node, instance, result = null, signal) {
    if (activityRefForNode(node)) {
      try { return await executeRegisteredActivity(session, node, instance, signal); }
      catch (error) {
        if (error?.code === 'ACTIVITY_RESOURCES_UNAVAILABLE')
          return { activityWaiting: true, output: { message: error.message, waitingFor: 'resources' } };
        throw error;
      }
    }
    return executeLegacyAction(session, node, instance, result);
  }

  async function reconcile(session, command) {
    const engine = getEngine();
    if (!session.flow || !['failed', 'interrupted', 'cancelled'].includes(session.flow.status)) throw new Error('No failed workflow effect needs reconciliation.');
    if (typeof command.instance !== 'string' || session.flow.instance !== command.instance) throw new Error('Workflow step instance has changed. Refresh before reconciling.');
    const node = engine.current(session); const effectKey = `${session.flow.id}:${command.instance}:${node.id}`;
    if (command.effectKey !== effectKey) throw new Error('Provide the exact workflow effect key.');
    const runForReconciliation = session.independentRun ? session : getWorkflowOwner()?.run(session.workflowRunId ?? session.flow.id);
    if (node.activity || (runForReconciliation?.attempt?.intent && runForReconciliation?.attempt?.activityRef)) {
      const owner = getWorkflowOwner();
      const run = session.independentRun ? session : owner?.run(session.workflowRunId ?? session.flow.id);
      const ref = owner?.getActivityRef(node);
      const descriptor = owner?.activityDescriptor(ref);
      const implementation = activityImplementations.get(`${ref?.id}@${ref?.revision}`);
      if (!run || !descriptor || !implementation || typeof implementation.reconcile !== 'function' || descriptor.reconciliation !== 'adapter')
        throw new Error('This pinned activity has no adapter reconciliation capability.');
      if (node.activityDescriptorDigest && activityDigest(descriptor) !== node.activityDescriptorDigest)
        throw new Error('Pinned activity metadata changed; reconciliation is blocked.');
      const reservation = owner.activityReservationForAttempt(run, node.id, command.instance);
      const authorization = await authorizeActivity(run, descriptor, node, reservation, { phase: 'reconcile' });
      if (run.attempt?.instance !== command.instance || run.attempt.nodeId !== node.id ||
          JSON.stringify(run.attempt.activityRef) !== JSON.stringify(ref) || !run.attempt.intent)
        throw new Error('Workflow activity intent is unavailable for reconciliation.');
      const input = owner.resolveActivityInput(run, node);
      const result = await implementation.reconcile({ run, session: session?.independentRun ? null : session,
        node, instance: command.instance, owner,
        ...(authorization?.model ? { model: authorization.model } : {}) }, input,
        structuredClone(run.attempt.intent), { requestedResolution: command.resolution });
      if (!result || !['applied', 'not_applied', 'unknown', 'waiting'].includes(result.state))
        throw new Error('Activity adapter returned an invalid reconciliation result.');
      const effectApplied = result.state === 'applied' || (result.state === 'waiting' && result.effectApplied === true);
      if (command.resolution === 'applied' && !effectApplied)
        throw new Error(result.message ?? 'The activity adapter has no canonical proof that the effect was applied.');
      if (command.resolution === 'not_applied' && result.state !== 'not_applied')
        throw new Error(`The activity adapter cannot confirm that this effect was not applied.${result.message ? ` ${result.message}` : ''}`);
      if (result.state === 'applied' && command.result && result.output && Object.entries(command.result).some(([key, value]) =>
          value === undefined ? Object.hasOwn(result.output, key) : !Object.hasOwn(result.output, key) ||
            activityDigest(result.output[key]) !== activityDigest(value)))
        throw new Error(result.message ?? 'Caller-supplied result does not match the canonical activity receipt.');
      await owner.reconcileActivityAttempt(session, { instance: command.instance, nodeId: node.id, ref,
        state: result.state, ...(result.output !== undefined ? { output: result.output } : {}), message: result.message });
      if (result.state === 'applied') {
        if (session.flow.status !== 'cancelled') {
          session.flow.status = 'running'; session.status = 'running';
          await engine.finishAutomated(session, command.instance, 'success', result.output);
        }
      } else if (result.state === 'waiting' && session.flow.status !== 'cancelled') {
        session.flow.status = 'running'; session.status = 'running';
        await engine.holdAction(session, command.instance, result.output ?? { message: result.message });
      } else if (result.state === 'not_applied' && session.flow.status !== 'cancelled') {
        session.flow.resumeStatus = 'ready'; session.flow.status = 'paused'; session.status = 'paused';
      }
      event(session, 'workflow_activity_reconciled', { effectKey, resolution: result.state, flowCancelled: session.flow.status === 'cancelled' });
      await save();
      return;
    }
    const effect = effectRecord(effectKey);
    if (!effect || !['pending', 'uncertain', 'succeeded'].includes(effect.status)) throw new Error('Workflow effect is not awaiting reconciliation.');
    if (!['applied', 'not_applied'].includes(command.resolution)) throw new Error('Confirm applied or not_applied explicitly.');
    if (effect.status === 'succeeded' && command.resolution !== 'applied') throw new Error('A recorded successful workflow effect cannot be discarded.');
    const cancelled = session.flow.status === 'cancelled';
    if (command.resolution === 'applied') {
      const cachedSuccess = effect.status === 'succeeded';
      if (cachedSuccess && (!effect.result || typeof effect.result !== 'object')) throw new Error('Recorded successful workflow effect has no result receipt.');
      const recorded = effect.command ?? {}; const targetId = recorded.ticketId ?? recorded.taskId;
      const appliedResult = cachedSuccess ? structuredClone(effect.result) : command.result;
      const reportedId = appliedResult?.id ?? appliedResult?.ticketId ?? appliedResult?.taskId;
      if (!appliedResult || typeof appliedResult !== 'object' || Array.isArray(appliedResult)) throw new Error('Applied effect confirmation must include the real command result.');
      if (!cachedSuccess && node.operation === 'send_external_reply') {
        const reply = state.ticketReplies.find(reply => reply.id === recorded.requestId && reply.ticketId === recorded.ticketId && reply.connectionId === recorded.connectionId && reply.body === recorded.body && reply.status === 'queued');
        if (!reply || command.result.id !== reply.id) throw new Error('Reconcile the matching external reply first and provide its request ID.');
        effect.result = structuredClone(reply);
      }
      else if (!cachedSuccess && ['create_ticket', 'create_related_ticket'].includes(node.operation)) { if (reportedId === undefined || !catalog.ticket(reportedId)) throw new Error('Applied create result must reference an existing ticket.'); }
      else if (!cachedSuccess && targetId !== undefined) {
        if (!catalog.ticket(targetId)) throw new Error('Applied effect target ticket no longer exists.');
        if (reportedId === undefined || String(reportedId) !== String(targetId)) throw new Error('Applied effect result must reference its recorded target ticket.');
      }
      effect.status = 'succeeded'; effect.result ??= appliedResult; effect.reconciledAt = now();
      saveEffect(effectKey, effect);
      if (cancelled) {
        event(session, 'workflow_effect_reconciled', { effectKey, resolution: 'applied', flowCancelled: true, cachedSuccess });
        await save();
        return;
      }
      if (['create_ticket', 'create_related_ticket'].includes(node.operation) && effect.result?.id !== undefined) { session.flow.ticketBindings ??= {}; session.flow.ticketBindings.last_created = effect.result.id; }
      session.flow.status = 'running'; session.status = 'running'; event(session, 'workflow_effect_reconciled', { effectKey, resolution: 'applied', cachedSuccess });
      try {
        const result = node.operation === 'send_external_reply' ? await sendApprovedReply(session, node, command.instance) : effect.result;
        if (result?.awaitingDelivery) await engine.holdAction(session, command.instance, result);
        else await engine.finishAutomated(session, command.instance, 'success', result);
      }
      catch (error) { session.flow.status = 'failed'; session.status = 'failed'; effect.status = 'uncertain'; effect.message = error.message; saveEffect(effectKey, effect); throw error; }
    } else {
      if (node.operation === 'send_external_reply' && state.ticketReplies.some(reply => reply.id === effect.command?.requestId))
        throw new Error('Reconcile the existing external reply; do not discard its send identity.');
      deleteEffect(effectKey);
      if (!cancelled) { session.flow.resumeStatus = 'ready'; session.flow.status = 'paused'; session.status = 'paused'; }
      event(session, 'workflow_effect_reconciled', { effectKey, resolution: 'not_applied', ...(cancelled ? { flowCancelled: true } : {}) });
    }
    await save();
  }

  async function retryTrigger(session, command) {
    const triggerKey = requireText(command.triggerKey, 500);
    const retry = await getWorkflowOwner()?.legacyDecisionForRetry(triggerKey);
    if (!retry) throw new Error('Workflow trigger retry is unavailable.');
    const { decision: record, rule } = retry;
    if (session.flow && !['completed', 'cancelled'].includes(session.flow.status)) throw new Error('The triggered workflow is already active.');
    const ticket = catalog.ticket(record.ticketId); if (!ticket) throw new Error('Triggered ticket no longer exists.');
    if (String(session.activeTicketId) !== String(ticket.id)) throw new Error('Decision belongs to another ticket.');
    if (rule) {
      if (ticket.projectId !== rule.projectId) throw new Error('Ticket project changed.');
      session.executionPrincipal = structuredClone(rule.principal);
      await authorizeStart(rule, session);
    }
    session.workflow = retry.workflow;
    await getWorkflowOwner()?.markLegacyDecisionPending(triggerKey);
    event(session, 'workflow_trigger_retry', { triggerKey, workflowId: retry.workflow.id, workflowVersion: retry.workflow.version }); await save();
    try { await getEngine().start(session, { triggerKey }); await getWorkflowOwner()?.markLegacyDecisionStarted(triggerKey); }
    catch (error) {
      await getWorkflowOwner()?.failLegacyDecision(triggerKey, error);
      event(session, 'workflow_trigger_failed', { triggerKey, workflowId: retry.workflow.id, ticketId: ticket.id, message: error.message });
    }
    await save();
  }

  return {
    boardCommand, observeBoardCommand, drainImportFacts, executeAction, reconcile, retryTrigger, prepareActivityIntent,
    async workflowRunFailed(session, error) {
      const triggerKey = session?.flow?.triggerKey;
      const record = triggerKey && state.automationDecisionLedger?.[triggerKey];
      if (!record || record.status !== 'started') return;
      const message = String(error?.message ?? 'Triggered workflow failed.').slice(0, 1000);
      await getWorkflowOwner()?.failLegacyDecision(triggerKey, error);
      event(session, 'workflow_trigger_failed', { triggerKey, workflowId: record.workflowId, ticketId: record.ticketId, message });
      await save();
    },
    hasActivity(ref) { return activityImplementations.has(`${ref?.id}@${ref?.revision}`); },
  };
}
