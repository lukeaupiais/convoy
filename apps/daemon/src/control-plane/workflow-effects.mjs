export function migrateWorkflowEffectState(state) {
  state.workflowTriggerLedger ??= {};
  state.workflowEffectLedger ??= {};
  state.workflowTriggerFailures ??= [];
  state.workflowTriggerFailures = state.workflowTriggerFailures.slice(-100);
}

/**
 * Owns every workflow side effect that can mutate board state. The ledger is
 * written before mutation so restarts fail closed instead of replaying an
 * uncertain create/update/move.
 */
export function createWorkflowEffects({ state, catalog, conversations, sessionFor, boards, makeSession, pinInstructions, normalizeWorkflow, event, save, now, getEngine, requireText, startRules, authorizeStart }) {
  migrateWorkflowEffectState(state);
  async function boardCommand(command) {
    const result = await (boards?.command ?? catalog.command)(command);
    return observeBoardCommand(command, result);
  }

  async function observeBoardCommand(command, result) {
    const placementChanged = result?.fromColumnId !== result?.toColumnId;
    const eventNames = ['createTicket', 'createRelatedTicket', 'createDevelopmentTicket'].includes(command.action) ? ['ticket_created'] : command.action === 'updateTicket' ? ['ticket_updated'] : ['setBoardPlacement', 'clearBoardPlacement'].includes(command.action) ? ['board_placement_changed', ...(placementChanged ? ['ticket_moved'] : [])] : [];
    // A related ticket is a new ticket and may start its own workflow.
    if (!eventNames.length || command.workflowRunId && !['createRelatedTicket', 'createDevelopmentTicket'].includes(command.action)) return result;
    const ticketId = ['createTicket', 'createRelatedTicket', 'createDevelopmentTicket'].includes(command.action)
      ? result?.id : command.ticketId ?? command.taskId ?? result?.ticketId ?? result?.id;
    const ticket = ticketId === undefined ? null : catalog.ticket(ticketId);
    if (!ticket) return result;
    const sourceKey = command.idempotencyKey ?? `${command.action}:${ticket.id}:${result?.revision ?? ticket.revision}`;
    for (const eventName of eventNames) await observeTicketFact(ticket, {
      event: eventName, sourceKey, boardId: command.boardId,
      fromColumnId: result?.fromColumnId, toColumnId: result?.toColumnId,
    });
    return result;
  }

  async function observeTicketFact(ticket, fact) {
    fact = { ...fact, ticketId: ticket.id };
    for (const session of Object.values(state.sessions)) {
      if (session.flow?.status !== 'waiting_event') continue;
      const node = getEngine().current(session);
      const waitFor = node?.waitFor;
      if (node?.kind !== 'wait' || waitFor.event !== fact.event || waitFor.status && ticket.status !== waitFor.status) continue;
      const matches = waitFor.ticketSource === 'related_ticket'
        ? state.ticketRelations?.some((link) => link.sourceTicketId === session.activeTicketId && link.targetTicketId === ticket.id && (!waitFor.relationKind || link.kind === waitFor.relationKind))
        : waitFor.ticketSource === 'linked_development'
        ? state.ticketDevelopmentLinks?.some((link) => link.supportTicketId === session.activeTicketId && link.developmentTicketId === ticket.id)
        : session.activeTicketId === ticket.id;
      if (matches) await getEngine().signal(session, session.flow.instance, fact);
    }
    const candidates = (state.workflowStartRules ?? []).filter((rule) =>
      startRules.matches(rule, { ...fact, projectId: ticket.projectId, workType: ticket.workType }));
    if (!candidates.length) return;
    const active = sessionFor(ticket);
    const blocked = candidates.length > 1 ? 'conflict' : active?.flow && !['completed', 'cancelled'].includes(active.flow.status) ? 'blocked_active' : null;
    for (const rule of candidates) {
      const key = `${rule.id}:${rule.revision}:${fact.sourceKey}`;
      if (state.workflowTriggerLedger[key]) continue;
      const record = { at: now(), status: blocked ?? 'pending', ruleId: rule.id, ruleRevision: rule.revision,
        workflowId: rule.workflowId, workflowVersion: rule.workflowVersion, ticketId: ticket.id,
        trigger: rule.event, attempts: blocked ? 0 : 1,
        ...(blocked === 'blocked_active' ? { activeSessionId: active.id, activeRunId: active.flow.id } : {}) };
      state.workflowTriggerLedger[key] = record;
      await save();
      if (blocked) continue;
      let session = active;
      if (!session) {
        session = makeSession(String(ticket.id), ticket.title);
        Object.assign(session, { projectId: ticket.projectId, activeTicketId: ticket.id });
        state.sessions[session.id] = session;
        conversations.adopt(session);
        pinInstructions(session);
      }
      try {
        const workflow = state.workflows.find((value) => value.id === rule.workflowId && value.version === rule.workflowVersion);
        if (!workflow) throw new Error('Pinned workflow version is unavailable.');
        session.workflow = { ...normalizeWorkflow(workflow), version: workflow.version };
        session.executionPrincipal = structuredClone(rule.principal);
        await authorizeStart(rule, session);
        event(session, 'workflow_triggered', { workflowId: workflow.id, ticketId: ticket.id, trigger: rule.event, sourceKey: key });
        await save();
        await getEngine().start(session);
        record.status = 'started';
      } catch (error) {
        record.status = 'failed'; record.message = error.message;
        state.workflowTriggerFailures.push({ at: now(), triggerKey: key, workflowId: rule.workflowId,
          workflowVersion: rule.workflowVersion, ticketId: ticket.id, trigger: rule.event, message: error.message });
        state.workflowTriggerFailures = state.workflowTriggerFailures.slice(-100);
        event(session, 'workflow_trigger_failed', { workflowId: rule.workflowId, ticketId: ticket.id, message: error.message });
      }
    }
    await save();
  }

  async function drainImportFacts() {
    for (const fact of state.ticketImportFacts ?? []) {
      if (fact.status !== 'pending') continue;
      const ticket = catalog.ticket(fact.ticketId);
      if (ticket) await observeTicketFact(ticket, { ...fact, sourceKey: fact.key });
      fact.status = 'observed';
      await save();
    }
    state.ticketImportFacts = (state.ticketImportFacts ?? []).filter((fact) => fact.status !== 'observed');
    await save();
  }

  async function executeAction(session, node, instance) {
    if (node.operation === 'inspect_changes') return null;
    if (!['create_ticket', 'create_related_ticket', 'create_development_ticket', 'update_ticket', 'move_ticket'].includes(node.operation)) throw new Error('Unsupported workflow action.');
    const payload = node.input ?? node.args ?? node.payload ?? {};
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
    else if (node.operation === 'create_development_ticket') {
      const support = catalog.ticket(command.supportTicketId ?? session.activeTicketId);
      if (!support || support.projectId !== session.projectId) throw new Error('Active support ticket is unavailable.');
      command.action = 'createDevelopmentTicket';
      command.supportTicketId = support.id;
      command.supportRevision = support.revision;
      command.projectId = support.projectId;
      if (!command.title) command.title = support.title;
      if (!command.description) command.description = `Reported in support ticket #${support.id}.\n\n${support.description}`;
    }
    else if (node.operation === 'update_ticket') { command.action = 'updateTicket'; command.taskId ??= command.ticketId; command.requestId ??= command.requestKey ?? `${session.flow.id}-${instance}`; }
    else { command.action = 'setBoardPlacement'; command.ticketId ??= command.taskId ?? session.activeTicketId; if (!command.placement && command.columnId) command.placement = { columnId: command.columnId, swimlaneKey: command.swimlaneKey }; }
    const target = command.ticketId ?? command.taskId;
    if (target !== undefined && command.revision === undefined) command.revision = catalog.ticket(target)?.revision;
    if (['create_ticket', 'create_related_ticket', 'create_development_ticket'].includes(node.operation)) command.requestId ??= command.requestKey ?? `${session.flow.id}-${instance}`;
    const effectKey = `${session.flow.id}:${instance}:${node.id}`;
    const previous = state.workflowEffectLedger[effectKey];
    if (previous) {
      if (previous.status === 'succeeded') return structuredClone(previous.result);
      throw new Error('Workflow board effect has an uncertain outcome. Inspect the board before retrying this step.');
    }
    state.workflowEffectLedger[effectKey] = {
      at: now(),
      status: 'pending',
      operation: node.operation,
      sessionId: session.id,
      projectId: session.projectId,
      organizationId: state.projects.find((project) => project.id === session.projectId)?.organizationId,
      command: structuredClone(command),
    };
    await save();
    try {
      const result = await boardCommand(command);
      if (['create_ticket', 'create_related_ticket', 'create_development_ticket'].includes(node.operation) && result?.id !== undefined) { session.flow.ticketBindings ??= {}; session.flow.ticketBindings.last_created = result.id; }
      state.workflowEffectLedger[effectKey] = {
        ...state.workflowEffectLedger[effectKey],
        status: 'succeeded',
        result: structuredClone(result),
      };
      await save();
      return result;
    } catch (error) {
      state.workflowEffectLedger[effectKey].status = 'uncertain'; state.workflowEffectLedger[effectKey].message = error.message;
      await save();
      throw error;
    }
  }

  async function reconcile(session, command) {
    const engine = getEngine();
    if (!session.flow || !['failed', 'interrupted'].includes(session.flow.status)) throw new Error('No failed workflow effect needs reconciliation.');
    if (typeof command.instance !== 'string' || session.flow.instance !== command.instance) throw new Error('Workflow step instance has changed. Refresh before reconciling.');
    const node = engine.current(session); const effectKey = `${session.flow.id}:${command.instance}:${node.id}`;
    if (command.effectKey !== effectKey) throw new Error('Provide the exact workflow effect key.');
    const effect = state.workflowEffectLedger[effectKey];
    if (!effect || !['pending', 'uncertain'].includes(effect.status)) throw new Error('Workflow effect is not awaiting reconciliation.');
    if (!['applied', 'not_applied'].includes(command.resolution)) throw new Error('Confirm applied or not_applied explicitly.');
    if (command.resolution === 'applied') {
      const recorded = effect.command ?? {}; const targetId = recorded.ticketId ?? recorded.taskId;
      const reportedId = command.result?.id ?? command.result?.ticketId ?? command.result?.taskId;
      if (!command.result || typeof command.result !== 'object' || Array.isArray(command.result)) throw new Error('Applied effect confirmation must include the real command result.');
      if (['create_ticket', 'create_related_ticket', 'create_development_ticket'].includes(node.operation)) { if (reportedId === undefined || !catalog.ticket(reportedId)) throw new Error('Applied create result must reference an existing ticket.'); }
      else if (targetId !== undefined) {
        if (!catalog.ticket(targetId)) throw new Error('Applied effect target ticket no longer exists.');
        if (reportedId === undefined || String(reportedId) !== String(targetId)) throw new Error('Applied effect result must reference its recorded target ticket.');
      }
      effect.status = 'succeeded'; effect.result = command.result; effect.reconciledAt = now();
      if (['create_ticket', 'create_related_ticket', 'create_development_ticket'].includes(node.operation) && effect.result?.id !== undefined) { session.flow.ticketBindings ??= {}; session.flow.ticketBindings.last_created = effect.result.id; }
      session.flow.status = 'running'; session.status = 'running'; event(session, 'workflow_effect_reconciled', { effectKey, resolution: 'applied' });
      try { await engine.finishAutomated(session, command.instance, 'success', effect.result); }
      catch (error) { session.flow.status = 'failed'; session.status = 'failed'; effect.status = 'uncertain'; effect.message = error.message; throw error; }
    } else {
      delete state.workflowEffectLedger[effectKey]; session.flow.resumeStatus = 'ready'; session.flow.status = 'paused'; session.status = 'paused';
      event(session, 'workflow_effect_reconciled', { effectKey, resolution: 'not_applied' });
    }
    await save();
  }

  async function retryTrigger(session, command) {
    const triggerKey = requireText(command.triggerKey, 500); const record = state.workflowTriggerLedger[triggerKey];
    if (!record || record.status !== 'failed') throw new Error('Workflow trigger is not failed or has already started.');
    if (session.flow && !['completed', 'cancelled'].includes(session.flow.status)) throw new Error('The triggered workflow is already active.');
    const rule = state.workflowStartRules?.find(value => value.id === record.ruleId && value.revision === record.ruleRevision);
    if (record.ruleId && (!rule || !rule.enabled)) throw new Error('Start automation changed. Review it before retrying.');
    const workflow = state.workflows.find(value => value.id === record.workflowId && value.version === record.workflowVersion);
    if (!workflow) throw new Error('The pinned workflow version for this trigger is unavailable.');
    const ticket = catalog.ticket(record.ticketId); if (!ticket) throw new Error('Triggered ticket no longer exists.');
    if (rule) {
      if (ticket.projectId !== rule.projectId) throw new Error('Ticket project changed.');
      session.executionPrincipal = structuredClone(rule.principal);
      await authorizeStart(rule, session);
    }
    session.workflow = { ...normalizeWorkflow(workflow), version: workflow.version };
    record.status = 'pending'; record.attempts = (record.attempts ?? 0) + 1; record.lastRetryAt = now();
    event(session, 'workflow_trigger_retry', { triggerKey, workflowId: workflow.id, workflowVersion: workflow.version }); await save();
    try { await getEngine().start(session); record.status = 'started'; }
    catch (error) {
      record.status = 'failed'; record.message = error.message;
      state.workflowTriggerFailures.push({ at: now(), triggerKey, workflowId: workflow.id, workflowVersion: workflow.version, ticketId: ticket.id, trigger: record.trigger, message: error.message });
      state.workflowTriggerFailures = state.workflowTriggerFailures.slice(-100);
      event(session, 'workflow_trigger_failed', { triggerKey, workflowId: workflow.id, ticketId: ticket.id, message: error.message });
    }
    await save();
  }

  return { boardCommand, observeBoardCommand, drainImportFacts, executeAction, reconcile, retryTrigger };
}
