import { builtinActivityDescriptors, legacyActivityRef, workflowActionInput } from '../modules/workflows/index.mjs';

const operationIds = {
  'work.create-ticket': 'create_ticket',
  'work.create-related-ticket': 'create_related_ticket',
  'work.update-ticket': 'update_ticket',
  'work.set-board-placement': 'move_ticket',
  'work.set-external-status': 'set_external_status',
  'work.post-external-reply': 'send_external_reply',
};
const commandActions = {
  create_ticket: 'createTicket', create_related_ticket: 'createRelatedTicket',
  update_ticket: 'updateTicket', move_ticket: 'setBoardPlacement',
  set_external_status: 'setExternalTicketStatus', send_external_reply: 'postExternalTicketReply',
};
const runOf = context => context?.independentRun ? context : context?.workflowRunId ? context : null;

function jsonValue(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : JSON.parse(encoded);
}

function legacyInput(node, context) {
  const input = structuredClone(workflowActionInput(node));
  if (input.ticketSource === 'last_created') {
    const id = context?.flow?.ticketBindings?.last_created ?? context?.flow?.actionResult?.id ?? context?.flow?.actionResult?.ticketId;
    if (id === undefined) throw new Error('No ticket was created by an earlier workflow action.');
    input.ticketId = id;
  }
  delete input.ticketSource;
  return input;
}

function replyBody(context, input, node) {
  const flow = context?.session?.flow ?? context?.run?.flow ?? context?.flow;
  if (context?.activityReservation) {
    const reservation = context.activityReservation;
    const sourceRef = flow?.decisionSubmissionRef;
    const entry = sourceRef && flow?.history?.find(value => value.nodeId === sourceRef.nodeId && value.instance === sourceRef.instance &&
      value.to === reservation.gateNodeId);
    const body = entry?.submission?.details?.[input.field];
    if (flow?.nodeId !== reservation.gateNodeId || flow?.instance !== reservation.gateInstance ||
        entry?.submission?.nodeId !== input.sourceNodeId || typeof body !== 'string' || !body.trim())
      throw new Error('No exact captured reply proposal is available for this approval reservation.');
    if (input.body !== undefined && input.body !== body) throw new Error('Reply body does not match the captured submission.');
    return body;
  }
  const approval = flow?.approvedSubmission;
  const reviewed = flow?.history?.some(entry => entry.nodeId === approval?.reviewNodeId &&
    entry.instance === approval?.reviewInstance && entry.outcome === 'approved' && entry.to === node.id);
  const body = approval?.submission?.details?.[input.field];
  if (!reviewed || approval?.submission?.nodeId !== input.sourceNodeId || typeof body !== 'string' || !body.trim())
    throw new Error('No approved captured reply is available for this activity.');
  if (input.body !== undefined && input.body !== body) throw new Error('Reply body does not match the approved captured submission.');
  return body;
}

function workCommandFor(refId, input, identity, context, catalog, state) {
  const operation = operationIds[refId];
  if (!operation) throw new Error(`No Work activity is registered for ${refId}.`);
  const legacy = context?.node?.operation ? context.node : null;
  const values = legacy ? legacyInput(legacy, context.session) : structuredClone(input);
  const command = { ...values, action: commandActions[operation], workflowRunId: identity.runId,
    workflowInstance: identity.instance, idempotencyKey: `${identity.runId}:${identity.instance}` };
  if (command.projectId !== undefined && command.projectId !== identity.projectId)
    throw new Error('Workflow action project is not available in the run project.');
  if (operation === 'create_ticket') {
    command.projectId = identity.projectId;
    command.requestId ??= command.requestKey ?? `${identity.runId}-${identity.instance}`;
  } else if (operation === 'create_related_ticket') {
    const source = catalog.ticket(command.sourceTicketId ?? context.session?.activeTicketId ?? context.run?.activeTicketId);
    if (!source || source.projectId !== identity.projectId) throw new Error('Active ticket is unavailable.');
    command.sourceTicketId = source.id;
    command.sourceRevision = command.sourceRevision ?? source.revision;
    command.requestId ??= command.requestKey ?? `${identity.runId}-${identity.instance}`;
  } else if (operation === 'update_ticket') {
    command.ticketId ??= command.taskId ?? context.session?.activeTicketId ?? context.run?.activeTicketId;
    command.taskId ??= command.ticketId;
    command.requestId ??= command.requestKey ?? `${identity.runId}-${identity.instance}`;
  } else if (operation === 'move_ticket') {
    command.ticketId ??= command.taskId ?? context.session?.activeTicketId ?? context.run?.activeTicketId;
  } else if (operation === 'set_external_status') {
    command.ticketId ??= context.session?.activeTicketId ?? context.run?.activeTicketId;
    command.requestId ??= command.requestKey ?? `${identity.runId}-${identity.instance}`;
    if (command.evidenceReply === 'latest_delivered') {
      const candidates = (state.ticketReplies ?? []).filter(reply => reply.ticketId === command.ticketId &&
        reply.connectionId === command.connectionId && reply.status === 'queued' &&
        reply.workflowRunId === identity.runId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (!candidates.length) throw new Error('No delivered reply from this workflow run was found.');
      command.evidenceReplyRequestId = candidates[0].id;
    }
    delete command.evidenceReply;
  } else if (operation === 'send_external_reply') {
    command.ticketId ??= context.session?.activeTicketId ?? context.run?.activeTicketId;
    command.body = replyBody(context, values, legacy ?? context.node);
    command.requestId = `reply-${identity.runId}-${identity.instance}`;
  }
  const ticketId = command.ticketId ?? command.taskId;
  if (ticketId !== undefined && command.revision === undefined) command.revision = catalog.ticket(ticketId)?.revision;
  return command;
}

async function confirmReply({ intent, context, workCommand, state }) {
  const command = intent.command;
  const thread = await workCommand({ action: 'syncExternalTicketThread', ticketId: command.ticketId, connectionId: command.connectionId }, context.session ?? context.run);
  const reply = state.ticketReplies?.find(value => value.id === command.requestId && value.ticketId === command.ticketId &&
    value.connectionId === command.connectionId && value.body === command.body && value.workflowRunId === command.workflowRunId &&
    value.workflowInstance === command.workflowInstance);
  const matchingOutbound = thread.messages?.some(message => message.remoteId === reply?.remoteId && message.body === command.body &&
    message.direction === 'outbound');
  const delivered = thread.messages?.some(message => message.remoteId === reply?.remoteId && message.body === command.body &&
    message.direction === 'outbound' && message.deliveryStatus === 'delivered');
  if (reply?.status !== 'queued' || !matchingOutbound || !delivered) return {
    state: 'waiting', output: { awaitingDelivery: true, replyRequestId: command.requestId,
      deliveryStatus: reply?.deliveryStatus ?? 'pending',
      message: 'Approved reply sent; delivery is not confirmed. Continue to check delivery without resending.' },
    ...(reply?.status === 'queued' && matchingOutbound ? { evidence: { matchingOutbound: true, remoteId: reply.remoteId } } : {}),
  };
  return { state: 'completed', output: jsonValue(reply) };
}

function clearedReplyBlock(context, command, state) {
  const effect = context?.owner?.effectForAttempt?.(context.run?.id, context.instance, context.node?.id);
  const requestId = effect?.blockingReplyRequestId;
  if (!requestId) return null;
  const blocker = state.ticketReplies?.find(value => value.id === requestId && value.ticketId === command.ticketId &&
    value.connectionId === command.connectionId);
  if (blocker?.status === 'queued' || blocker?.status === 'not-posted')
    return { state: 'not_applied', message: 'Work confirms the blocking reply is resolved; this workflow reply was not dispatched.' };
  return { state: 'waiting', message: 'The exact blocking reply remains unresolved in Work.' };
}

async function confirmWorkMutation({ refId, intent, state, catalog, workReceipt, context }) {
  const command = intent.command;
  if (refId === 'work.create-ticket') {
    const exactReceipt = await workReceipt?.(command);
    // New typed activities require the exact owner receipt. The state projection
    // fallback exists only for already-published legacy operations.
    if (!exactReceipt?.result && !context?.node?.operation) return { state: 'unknown' };
    const ticketId = state.ticketRequests?.[command.requestId];
    const ticket = ticketId === undefined ? null : catalog.ticket(ticketId);
    if (!ticket || ticket.projectId !== command.projectId) return { state: 'unknown' };
    if (ticket.externalPublish?.state === 'outcome-unknown') return { state: 'waiting', output: {
      id: ticket.id, projectId: ticket.projectId, revision: ticket.revision,
      externalPublish: { connectionId: ticket.externalPublish.connectionId, state: ticket.externalPublish.state },
      message: 'External creation outcome is unknown. Reconcile it in Work before continuing.',
    } };
    if (command.destination && command.destination !== 'convoy' &&
        !ticket.externalLinks?.some(link => link.connectionId === command.destination))
      return { state: 'waiting', output: { id: ticket.id, projectId: ticket.projectId, revision: ticket.revision,
        message: 'The local ticket exists, but the requested external creation is not confirmed.' } };
    return { state: 'completed', output: receipt(exactReceipt?.result ?? ticket) };
  }
  if (refId === 'work.create-related-ticket') {
    const exactReceipt = await workReceipt?.(command);
    if (!exactReceipt?.result && !context?.node?.operation) return { state: 'unknown' };
    const result = exactReceipt?.result;
    if (!result?.id || !state.ticketRelations?.some(value => value.sourceTicketId === command.sourceTicketId &&
        value.targetTicketId === result.id && value.kind === command.kind)) return { state: 'unknown' };
    return { state: 'completed', output: jsonValue(result) };
  }
  if (refId === 'work.set-external-status') {
    const change = state.ticketStatusChanges?.find(value => value.id === command.requestId);
    if (change?.state === 'applied') return { state: 'completed', output: jsonValue(change) };
    if (change?.state === 'rejected') return { state: 'failed', message: 'Work recorded that the external status change was rejected.' };
    if (change?.state === 'outcome-unknown') return { state: 'waiting', output: {
      ticketId: change.ticketId, status: change.state, requestId: change.id,
      message: 'External status outcome is unknown. Reconcile it in Work before continuing.',
    } };
    return { state: 'unknown' };
  }
  if (['work.update-ticket', 'work.set-board-placement'].includes(refId)) {
    const workReceiptRow = await workReceipt?.(command);
    if (!workReceiptRow?.result) return { state: 'unknown' };
    const result = workReceiptRow.result;
    if (refId === 'work.update-ticket' && result.externalLinks?.some(link => link.syncState === 'error')) {
      const current = catalog.ticket(result.id);
      const failedLink = result.externalLinks.find(link => link.syncState === 'error');
      const currentLink = current?.externalLinks?.find(link => link.connectionId === failedLink?.connectionId &&
        link.remoteId === failedLink?.remoteId);
      const synced = current && current.title === result.title && current.description === result.description &&
        currentLink?.syncState === 'linked' &&
        (currentLink.fieldOwnership?.title !== 'convoy' || currentLink.remoteTitle === result.title) &&
        (currentLink.fieldOwnership?.description !== 'convoy' || currentLink.remoteDescription === result.description);
      if (!synced) return { state: 'waiting', output: receipt(result) };
      return { state: 'completed', output: receipt(result) };
    }
    return { state: 'completed', output: jsonValue(result) };
  }
  return { state: 'unknown' };
}

function receipt(ticket) {
  return Object.fromEntries(['id', 'ticketId', 'projectId', 'title', 'status', 'revision']
    .filter(key => ticket?.[key] !== undefined).map(key => [key, ticket[key]]));
}

export function createBuiltinWorkflowActivityImplementations({ workCommand, workReceipt, catalog, state, inspectChanges }) {
  const implementations = new Map();
  implementations.set('data.multiply@1', {
    async prepare(input) { return { inputDigest: JSON.stringify(input) }; },
    async dispatch(_context, input, _intent, signal) {
      if (signal?.aborted) return { state: 'failed', message: 'Activity was cancelled before dispatch.' };
      const amount = input.amount * input.factor;
      if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000_000_000)
        throw new Error('Multiply result is outside the declared output bounds.');
      return { state: 'completed', output: { amount } };
    },
  });
  implementations.set('runner.inspect-changes@1', {
    async prepare(input, _identity, context) {
      const session = context.session ?? (context.run?.sessionId ? state.sessions?.[context.run.sessionId] : null);
      if (!session?.workspace || !session.runnerId) throw new Error('Inspect changes requires an active workspace and runner.');
      return { workspace: { runnerId: session.runnerId, workspaceId: session.workspace.id ?? session.workspace.path,
        grantDigest: session.executionGrant?.digest ?? null }, ignoreArtifact: input.ignoreArtifact ?? null };
    },
    async dispatch(context, _input, intent, signal) {
      const session = context.session ?? (context.run?.sessionId ? state.sessions?.[context.run.sessionId] : null);
      if (!session?.workspace || !session.runnerId || session.runnerId !== intent.workspace.runnerId ||
          (session.workspace.id ?? session.workspace.path) !== intent.workspace.workspaceId ||
          (session.executionGrant?.digest ?? null) !== intent.workspace.grantDigest)
        throw new Error('Inspect changes workspace authority changed before dispatch.');
      const observed = await inspectChanges(session, intent.ignoreArtifact ?? undefined, signal);
      if (!observed || typeof observed.digest !== 'string') throw new Error('Runner returned invalid change evidence.');
      return { state: 'completed', output: { digest: observed.digest,
        changedFiles: Array.isArray(observed.changedFiles) ? observed.changedFiles.slice(0, 256) : [] } };
    },
    async reconcile() { return { state: 'unknown' }; },
  });
  for (const refId of Object.keys(operationIds)) {
    implementations.set(`${refId}@1`, {
      async prepare(input, identity, context) {
        const command = workCommandFor(refId, input, identity, context, catalog, state);
        return { command };
      },
      async dispatch(context, _input, intent, signal) {
        if (signal?.aborted) return { state: 'failed', message: 'Activity was cancelled before dispatch.' };
        if (refId === 'work.post-external-reply') {
          const prior = context.owner?.effectForAttempt(context.run.id, context.instance, context.node.id);
          if (prior?.blockingReplyRequestId) {
            const blocker = state.ticketReplies?.find(value => value.id === prior.blockingReplyRequestId &&
              value.ticketId === intent.command.ticketId && value.connectionId === intent.command.connectionId);
            if (!['queued', 'not-posted'].includes(blocker?.status)) return { state: 'failed', message: 'The exact blocking reply must be reconciled in Work before this reply can be sent.', output: {
              awaitingDelivery: true, blockingReplyRequestId: prior.blockingReplyRequestId,
              deliveryStatus: blocker?.status ?? prior.blockingReplyStatus ?? 'unknown',
              message: 'The exact blocking reply must be reconciled in Work before this reply can be sent.',
            }, evidence: { workPreDispatch: true, blockingReplyRequestId: prior.blockingReplyRequestId, blockingReplyStatus: blocker?.status ?? prior.blockingReplyStatus } };
          }
          if (prior?.status === 'succeeded') return confirmReply({ intent, context, workCommand, state });
        }
        try {
          const result = await workCommand(intent.command, context.session ?? context.run);
          if (refId === 'work.post-external-reply') return confirmReply({ intent, context, workCommand, state });
          if (refId === 'work.create-ticket' && result?.externalPublish?.state === 'outcome-unknown')
            return { state: 'waiting', output: { id: result.id, projectId: result.projectId, revision: result.revision,
              externalPublish: { connectionId: result.externalPublish.connectionId, state: 'outcome-unknown' },
              message: 'External creation outcome is unknown. Reconcile it in Work before continuing.' } };
          if (refId === 'work.set-external-status') {
            const receipt = state.ticketStatusChanges?.find(value => value.id === intent.command.requestId);
            if (receipt?.state === 'outcome-unknown') return { state: 'waiting', output: { ticketId: receipt.ticketId,
              status: receipt.state, requestId: receipt.id, message: 'External status outcome is unknown. Reconcile it in Work before continuing.' } };
          }
          if (refId === 'work.update-ticket' && result?.externalLinks?.some(link => link.syncState === 'error'))
            return { state: 'waiting', output: { id: result.id, projectId: result.projectId, revision: result.revision,
              message: 'External content synchronization is unresolved in Work.' } };
          return { state: 'completed', output: jsonValue(result) };
        } catch (error) {
          if (refId === 'work.post-external-reply' && error?.code === 'TICKET_REPLY_UNRESOLVED' && error?.outcome === 'not-dispatched')
            return { state: 'failed', message: error.message, output: { awaitingDelivery: true, message: error.message,
              replyRequestId: intent.command.requestId, deliveryStatus: error.blockingReplyStatus ?? 'pending' },
              evidence: { workPreDispatch: true, blockingReplyRequestId: error.blockingReplyRequestId, blockingReplyStatus: error.blockingReplyStatus } };
          throw error;
        }
      },
      async reconcile(_context, _input, intent, resolution) {
        const command = intent.command;
        if (operationIds[refId] === 'create_ticket') {
          const exactReceipt = await workReceipt?.(command);
          if (!exactReceipt?.result && !_context?.node?.operation)
            return { state: 'unknown', message: 'Work has no exact creation receipt for this workflow attempt.' };
          if (exactReceipt?.result) {
            const result = exactReceipt.result;
            if (result.externalPublish?.state === 'outcome-unknown') return { state: 'unknown', message: 'Work still records an unknown external creation outcome.' };
            if (command.destination && command.destination !== 'convoy' &&
                !result.externalLinks?.some(link => link.connectionId === command.destination))
              return { state: 'unknown', message: 'The exact creation receipt has no confirmation for the requested destination.' };
            return { state: 'applied', output: receipt(result), message: 'Applied reconciliation requires the existing ticket result in canonical Work.' };
          }
          const ticketId = state.ticketRequests?.[command.requestId];
          const ticket = ticketId === undefined ? null : catalog.ticket(ticketId);
          if (ticket?.projectId === command.projectId && command.destination && command.destination !== 'convoy') {
            if (ticket.externalPublish?.state === 'outcome-unknown') return { state: 'unknown', message: 'Work still records an unknown external creation outcome.' };
            if (ticket.externalLinks?.some(link => link.connectionId === command.destination)) return { state: 'applied', output: receipt(ticket) };
            return { state: 'unknown', message: 'The requested external creation has no canonical confirmation.' };
          }
          if (ticket?.projectId === command.projectId) return { state: 'applied', output: receipt(ticket), message: 'Applied reconciliation requires the existing ticket result in canonical Work.' };
          if (!ticket) return { state: 'not_applied' };
          return { state: 'unknown' };
        }
        if (refId === 'work.set-external-status') {
          const change = state.ticketStatusChanges?.find(value => value.id === command.requestId);
          if (change?.state === 'applied') return { state: 'applied', output: jsonValue(change) };
          if (change?.state === 'rejected') return { state: 'not_applied', message: 'Work confirms the external status change was rejected.' };
          if (change?.state === 'outcome-unknown') return { state: 'unknown', message: 'Work still records an unknown external status outcome.' };
          return { state: 'not_applied' };
        }
        if (refId === 'work.post-external-reply') {
          const reply = state.ticketReplies?.find(value => value.id === command.requestId && value.ticketId === command.ticketId &&
            value.connectionId === command.connectionId && value.body === command.body && value.workflowRunId === command.workflowRunId &&
            value.workflowInstance === command.workflowInstance);
          const block = clearedReplyBlock(_context, command, state);
          if (block) return block;
          if (reply?.status === 'not-posted') return { state: 'not_applied', message: 'Work confirms the exact external reply was not posted.' };
          if (reply) {
            if (!['pending', 'outcome-unknown', 'queued'].includes(reply.status))
              return { state: 'unknown', message: 'Work reply state does not prove delivery or non-delivery.' };
            const confirmed = await confirmReply({ intent, context: _context, workCommand, state });
            if (confirmed.state === 'completed') return { state: 'applied', output: confirmed.output };
            if (confirmed.evidence?.matchingOutbound === true) return { state: 'waiting', effectApplied: true,
              output: confirmed.output, message: 'The exact reply is recorded outbound; delivery confirmation is still pending.' };
            return { state: 'waiting', output: confirmed.output, message: resolution.requestedResolution === 'not_applied'
              ? 'An existing external reply must be reconciled before this effect can be treated as not applied.'
              : 'Reply delivery is still awaiting Work confirmation.' };
          }
          return { state: 'unknown', message: 'Work has no canonical reply receipt proving the external send was not applied.' };
        }
        if (['work.update-ticket', 'work.set-board-placement', 'work.create-related-ticket'].includes(refId)) {
          const receipt = await workReceipt?.(command);
          return receipt?.result ? { state: 'applied', output: jsonValue(receipt.result) }
            : { state: 'unknown', message: 'Work has no exact mutation receipt for this workflow attempt.' };
        }
        // Other Work mutations require the Work owner to provide a durable
        // matching receipt; never treat a caller-supplied result as proof.
        return { state: 'unknown', message: 'Work does not expose a matching durable receipt for this mutation.' };
      },
      async confirm(context, input, intent) {
        if (refId === 'work.post-external-reply') {
          const blocker = clearedReplyBlock(context, intent.command, state);
          if (blocker?.state === 'not_applied') return { state: 'retry' };
          if (blocker) return { state: 'waiting', output: context.run.attempt.waitingOutput };
          return confirmReply({ intent, context, workCommand, state });
        }
        const confirmation = await confirmWorkMutation({ refId, intent, state, catalog, workReceipt, context });
        if (confirmation.state === 'completed') return confirmation;
        if (confirmation.state === 'waiting') return confirmation;
        if (confirmation.state === 'failed') return confirmation;
        return { state: 'uncertain', message: confirmation.message ?? 'Work has no exact receipt confirming this activity.' };
      },
    });
  }
  return implementations;
}

export function createWorkflowActivityImplementationMap({ workCommand, workReceipt, catalog, state, inspectChanges, injected = [] }) {
  const map = createBuiltinWorkflowActivityImplementations({ workCommand, workReceipt, catalog, state, inspectChanges });
  for (const registration of injected) {
    const key = `${registration?.descriptor?.ref?.id}@${registration?.descriptor?.ref?.revision}`;
    if (!registration?.implementation || map.has(key)) throw new Error(`Activity implementation ${key} is invalid or duplicated.`);
    map.set(key, registration.implementation);
  }
  for (const descriptor of [...builtinActivityDescriptors, ...injected.map(value => value.descriptor)]) {
    const implementation = map.get(`${descriptor.ref.id}@${descriptor.ref.revision}`);
    if (!implementation || typeof implementation.prepare !== 'function' || typeof implementation.dispatch !== 'function' ||
        descriptor.confirmation === 'adapter-confirmed' && typeof implementation.confirm !== 'function' ||
        descriptor.reconciliation === 'adapter' && typeof implementation.reconcile !== 'function')
      throw new Error(`Activity ${descriptor.ref.id}@${descriptor.ref.revision} does not implement its declared lifecycle.`);
  }
  return map;
}

export function activityRefForNode(node) {
  return node?.activity ?? legacyActivityRef(node?.operation);
}
