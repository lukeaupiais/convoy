/**
 * Reconcile persisted conversations after a daemon restart.
 *
 * A restart is an uncertainty boundary: commands and tools may have changed the
 * workspace even when their result was never persisted. Recovery therefore
 * records uncertainty and requires an explicit resume instead of replaying work.
 */
export function recoverSessions({ state, ensureAgentSessions, migrateRun, steering, event }) {
  for (const session of Object.values(state.sessions)) {
    for (const command of session.commands ?? []) {
      if (command.state !== 'exited') {
        command.state = 'lost';
        command.reason = 'daemon_restarted';
      }
    }
    for (const terminal of session.terminals ?? []) {
      if (terminal.state !== 'exited') {
        terminal.state = 'lost';
        terminal.reason = 'daemon_restarted';
        terminal.endedAt = Date.now();
      }
    }

    session.lease = null;
    session.pendingMessages ??= [];
    if (session.pendingMessages.length || session.stopRequested) {
      steering.hold(session, 'Daemon restarted. Resume explicitly.');
    }
    if (session.pendingTurnInput) {
      session.queuedInput = session.pendingTurnInput;
      delete session.pendingTurnInput;
      session.status = 'interrupted';
    }
    if (session.pendingMessages.some(message => message.held) && !session.flow) {
      session.status = 'interrupted';
    }
    delete session.autoResume;
    delete session.stopRequested;

    ensureAgentSessions(session);
    session.messages = session.agentSessions[session.currentAgentSessionId].messages;
    migrateRun(session);

    for (const record of Object.values(session.agentSessions)) {
      const resolved = new Set(record.messages
        .filter(message => message.role === 'toolResult')
        .map(message => message.toolCallId));
      for (const message of [...record.messages]) {
        if (message.role !== 'assistant') continue;
        for (const call of message.content) {
          if (call.type !== 'toolCall' || resolved.has(call.id)) continue;
          record.messages.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{
              type: 'text',
              text: 'Daemon restarted before the tool result was recorded. Operation outcome is unknown; inspect workflow events and workspace before retrying. Do not replay automatically.',
            }],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }
    }

    if (session.flow && ['running', 'ready'].includes(session.flow.status)) {
      session.flow.status = 'interrupted';
    }
    if (['running', 'waiting_approval', 'waiting_question', 'queued', 'ready'].includes(session.status)) {
      steering.interrupt(
        session,
        'Daemon restarted. Inspect recorded results before resuming.',
        Boolean(session.inFlightTool?.mutating),
      );
      delete session.inFlightTool;
      session.status = 'interrupted';
      session.pending = null;
      session.pendingQuestion = null;
      event(session, 'interrupted', {
        message: 'Daemon restarted. Inspect workspace before continuing; mutations were not replayed.',
      });
    }
    if (session.inFlightTool) {
      steering.interrupt(
        session,
        'Daemon restarted during tool execution. Inspect the original workspace.',
        Boolean(session.inFlightTool.mutating),
      );
      delete session.inFlightTool;
    }
  }
}
