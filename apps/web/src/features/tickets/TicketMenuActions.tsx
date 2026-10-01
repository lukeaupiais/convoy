import { useState } from 'react';
import {
  command,
  owns,
  type RuntimeAction,
  type RuntimeState,
  type Session,
  type Ticket,
} from '../../shared/api/runtime';
import { ticketWorkflowActions } from './workflow-actions';
import { ticketNeedsRecovery } from './ticket-menu-state';

export function TicketMenuActions({
  state,
  ticket,
  session,
  runtimeAvailable = true,
  onExecutionDetails,
  onRecovery,
  onActionComplete,
  onWorkingChange,
}: {
  state: RuntimeState;
  ticket: Ticket;
  session?: Session;
  runtimeAvailable?: boolean;
  onExecutionDetails: () => void;
  onRecovery: () => void;
  onActionComplete?: () => void;
  onWorkingChange?: (working: boolean) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function act(action: RuntimeAction) {
    if (!session || working || !runtimeAvailable) return;
    setWorking(true);
    onWorkingChange?.(true);
    setError('');
    try {
      if (!owns(session))
        await command('claim', { sessionId: session.id, label: 'Ticket workflow' });
      await command(action, { sessionId: session.id });
    } catch (reason) {
      setError((reason as Error).message);
      throw reason;
    } finally {
      setWorking(false);
      onWorkingChange?.(false);
    }
  }

  const actions = session
    ? ticketWorkflowActions(session, act)
    : {};
  async function runMenuAction(action: (() => void | Promise<void> | boolean) | undefined) {
    if (!action) return;
    try {
      const result = await action();
      if (result !== false) onActionComplete?.();
    } catch {
      // Keep the menu open so the command error stays visible.
    }
  }
  const hasWorkflow = Boolean(session?.flow?.instance);
  const canPause = Boolean(
    hasWorkflow &&
      session?.flow &&
      !['paused', 'completed', 'cancelled'].includes(session.flow.status),
  );
  const canCancel = Boolean(
    hasWorkflow && session?.flow && !['completed', 'cancelled'].includes(session.flow.status),
  );

  return (
    <>
      <button role="menuitem" onClick={onExecutionDetails}>
        Execution details
      </button>
      {error && <span role="alert">{error}</span>}
      {canPause && (
        <button
          role="menuitem"
          disabled={working || !runtimeAvailable}
          onClick={() => void runMenuAction(actions.pause)}
        >
          Pause workflow
        </button>
      )}
      {canCancel && (
        <button
          role="menuitem"
          disabled={working || !runtimeAvailable}
          onClick={() => void runMenuAction(actions.cancel)}
        >
          Cancel workflow
        </button>
      )}
      {session && ticketNeedsRecovery(state, ticket, session) && (
        <button role="menuitem" onClick={onRecovery}>
          Recovery
        </button>
      )}
    </>
  );
}
