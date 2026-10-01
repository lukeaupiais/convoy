import type { RuntimeState, Session, Ticket } from '../../shared/api/runtime';

export function ticketNeedsRecovery(state: RuntimeState, ticket: Ticket, session?: Session) {
  const flow = session?.flow;
  const effectKey =
    flow?.id && flow.instance && flow.nodeId
      ? `${flow.id}:${flow.instance}:${flow.nodeId}`
      : '';
  return Boolean(
    (flow && ['paused', 'failed', 'interrupted', 'awaiting_submission'].includes(flow.status)) ||
      session?.assignment?.state === 'uncertain' ||
      state.workflowEffects?.some(
        (effect) =>
          effect.effectKey === effectKey &&
          ['pending', 'uncertain', 'blocked'].includes(effect.status),
      ) ||
      state.automationDecisions?.some(
        (decision) =>
          String(decision.ticketId) === String(ticket.id) &&
          ['failed', 'blocked_active'].includes(decision.status),
      ),
  );
}
