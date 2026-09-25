import type { RuntimeState, Session } from '../../shared/api/runtime';

export type SessionBucket = 'active' | 'attention' | 'paused' | 'history' | 'idle';
export function sessionBucket(s: Session): SessionBucket {
  if (
    s.pending ||
    s.pendingQuestion ||
    s.assignment?.state === 'uncertain' ||
    s.interruption?.needsReview
  )
    return 'attention';
  if (s.terminals?.some((t) => t.state === 'running')) return 'active';
  if (
    [
      'waiting_approval',
      'waiting_question',
      'waiting_gate',
      'awaiting_continue',
      'awaiting_submission',
      'failed',
      'interrupted',
    ].includes(s.status)
  )
    return 'attention';
  if (s.status === 'paused') return 'paused';
  if (['running', 'queued', 'ready'].includes(s.status)) return 'active';
  // A normal chat reply is not a request for operational review.
  if (
    s.status === 'awaiting_review' &&
    (s.activeTicketId ||
      s.workspace ||
      (s.flow && !['completed', 'cancelled'].includes(s.flow.status)))
  )
    return 'attention';
  if (
    s.events.some((e) =>
      ['user', 'assistant', 'workflow_completed', 'tool_result'].includes(e.type),
    )
  )
    return 'history';
  return 'idle';
}

export function sessionStatus(s: Session, uncertainEffect = false): string {
  if (uncertainEffect) return 'Effect uncertain';
  if (s.assignment?.state === 'uncertain' || s.interruption?.needsReview)
    return 'Outcome uncertain';
  if (s.pending || s.status === 'waiting_approval') return 'Approval needed';
  if (s.pendingQuestion || s.status === 'waiting_question') return 'Question';
  if (s.status === 'waiting_gate' || s.flow?.status === 'waiting_gate') return 'Decision needed';
  if (s.status === 'awaiting_review') return 'Review needed';
  if (s.status === 'failed' || s.status === 'interrupted') return 'Inspect failure';
  if (s.status === 'awaiting_submission' || s.status === 'awaiting_continue')
    return 'Waiting to continue';
  if (s.status === 'queued' || s.status === 'ready') return 'Queued';
  if (s.status === 'paused') return 'Paused';
  if (s.terminals?.some((t) => t.state === 'running')) return 'Terminal running';
  return 'Running';
}

export function sessionProjectId(s: Session, state: RuntimeState): string | undefined {
  return s.projectId ?? state.tickets.find((ticket) => ticket.id === s.activeTicketId)?.projectId;
}

export function liveModel(state: RuntimeState, projectFilter = '') {
  const inProject = (projectId?: string) => !projectFilter || projectId === projectFilter;
  const sessions = state.sessions.filter((s) => inProject(sessionProjectId(s, state)));
  const uncertainEffects = (state.workflowEffects ?? []).filter(
    (effect) => effect.status === 'uncertain',
  );
  const effectSession = (effectKey: string) =>
    sessions.find((s) =>
      Boolean(s.flow?.id && effectKey.startsWith(`${s.flow.id}:${s.flow.instance}:`)),
    );
  const sort = (a: Session, b: Session) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const attention = sessions
    .filter(
      (s) =>
        sessionBucket(s) === 'attention' ||
        uncertainEffects.some((effect) => effectSession(effect.effectKey)?.id === s.id),
    )
    .sort(sort);
  const active = sessions
    .filter((s) => sessionBucket(s) === 'active' && !attention.includes(s))
    .sort(sort);
  const paused = sessions
    .filter((s) => sessionBucket(s) === 'paused' && !attention.includes(s))
    .sort(sort);
  const history = sessions
    .filter((s) => sessionBucket(s) === 'history' && !attention.includes(s))
    .sort(sort);
  const triggerFailures = (state.automationDecisions ?? []).filter(decision =>
    ['failed', 'blocked_active'].includes(decision.status) && inProject(state.tickets.find(ticket => ticket.id === decision.ticketId)?.projectId));
  const orphanEffects = uncertainEffects.filter(
    (effect) => !effectSession(effect.effectKey) && !projectFilter,
  );
  return {
    attention,
    active,
    paused,
    history,
    triggerFailures,
    orphanEffects,
    attentionCount: attention.length + triggerFailures.length + orphanEffects.length,
    uncertainEffectFor: (s: Session) =>
      uncertainEffects.some((effect) => effectSession(effect.effectKey)?.id === s.id),
  };
}

export function sessionReason(s: Session): string {
  if (s.control?.stopping) return 'Stopping the current turn; queued messages are held.';
  if (s.interruption?.needsReview) return 'Inspect possible partial effects before resuming.';
  if (s.assignment?.state === 'uncertain')
    return 'Inspect the original environment before reconciling execution.';
  if (s.pending) return `Approval needed: ${s.pending.tool}`;
  if (s.pendingQuestion) return s.pendingQuestion.question;
  if (s.queueReason) return s.queueReason;
  if (s.terminals?.some((t) => t.state === 'running'))
    return 'Native workspace terminal is running.';
  if (s.flow?.status === 'waiting_gate') return 'Waiting for a human workflow decision.';
  if (s.status === 'awaiting_review')
    return sessionBucket(s) === 'attention'
      ? 'Execution finished. Review the result; it has not been accepted.'
      : 'Conversation turn completed.';
  if (s.status === 'failed' || s.status === 'interrupted')
    return 'Inspect the last result before continuing.';
  if (s.status === 'paused') return 'Workflow paused. Resume when ready.';
  if (s.status === 'awaiting_submission')
    return 'The agent has not submitted the required step evidence.';
  if (s.status === 'awaiting_continue')
    return 'Step submitted. Waiting for an explicit continuation.';
  return (
    s.workflow?.steps[s.step]?.name ??
    (s.status === 'running' ? 'Agent is working.' : 'Past agent activity.')
  );
}
