import type { Session } from '../../shared/api/runtime';

export type SessionBucket = 'active' | 'attention' | 'history' | 'idle';
export function sessionBucket(s: Session): SessionBucket {
  if (s.pending || s.pendingQuestion || s.assignment?.state === 'uncertain') return 'attention';
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
      'paused',
    ].includes(s.status)
  )
    return 'attention';
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
