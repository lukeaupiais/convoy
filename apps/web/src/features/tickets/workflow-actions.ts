import type { RuntimeAction, RuntimeState, Session, Ticket } from '../../shared/api/runtime';
import type { WorkflowInteractionActions } from '../workflows';

type Act = (action: RuntimeAction, input?: object) => void | Promise<void>;

export function ticketWorkflowActions(
  session: Session,
  act: Act,
  options: { startRun?: () => void } = {},
): WorkflowInteractionActions {
  const instance = session.flow?.instance;
  if (!instance) return {};
  return {
    approveGate: () => act('approveGate', { instance }),
    requestChanges: (feedback) => act('requestChanges', { instance, feedback }),
    continueRun: () => act('continueWorkflow', { instance }),
    pause: () => act('pauseWorkflow'),
    cancel: () => {
      if (!confirm('Cancel this workflow? Its worktree and conversation will be preserved.'))
        return false;
      return act('cancelWorkflow');
    },
    answerQuestion: (questionId, answer) => act('answerQuestion', { questionId, answer }),
    decideTool: (approvalId, allow) => act('decide', { approvalId, allow }),
    allowAlwaysTool: (approvalId) => act('decide', { approvalId, decision: 'allow_always' }),
    refreshDiff: () => act('diff'),
    startRun: options.startRun,
    rework: () => act('reviseSubmission', { instance, feedback: 'Request a fresh submission.' }),
  };
}

export function ticketReplyDestination(state: RuntimeState, ticket: Ticket, connectionId: string) {
  const connection = state.ticketConnections?.find((source) => source.id === connectionId);
  const link = ticket.externalLinks?.find((source) => source.connectionId === connectionId);
  return {
    name: connection?.name,
    remoteId: link?.remoteKey ?? link?.remoteId,
  };
}
