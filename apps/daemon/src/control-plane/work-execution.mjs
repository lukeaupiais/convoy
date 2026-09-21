/**
 * Cross-domain read model used by Work. Work owns tickets and boards, while the
 * control plane owns how live sessions constrain edits and decorate snapshots.
 * This interface keeps session storage and lifecycle fields out of Work.
 */
export function createWorkExecution({ state, jobs }) {
  function sessionFor(ticket) {
    const session = ticket ? state.sessions[ticket.executionSessionId ?? String(ticket.id)] : undefined;
    return session && (session.activeTicketId === undefined || session.activeTicketId === ticket.id) ? session : undefined;
  }

  return {
    sessionFor,
    legacyTicketSeeds() {
      return Object.values(state.sessions)
        .filter(session => /^\d+$/.test(session.id))
        .map(session => ({
          id: Number(session.id),
          title: session.title,
          description: session.description,
          status: session.boardPhase ?? (session.status === 'idle' ? 'Backlog' : 'In progress'),
          createdAt: session.updatedAt,
        }));
    },
    reservedTicketIds() {
      return Object.keys(state.sessions).filter(id => /^\d+$/.test(id)).map(Number);
    },
    migratedStatus(ticket) {
      return state.sessions[ticket.executionSessionId ?? String(ticket.id)]?.boardPhase;
    },
    assertEditable(ticket, queuedPlacement = false) {
      const session = sessionFor(ticket);
      if (session && (jobs.has(session.id) || !(queuedPlacement && session.status === 'queued') && (session.queuedInput || session.flow && !['completed', 'cancelled'].includes(session.flow.status)))) {
        throw new Error('Cancel or finish execution before changing task instructions or placement.');
      }
    },
    isBusy(ticket) {
      const session = sessionFor(ticket);
      return Boolean(session && (jobs.has(session.id) || session.flow && !['completed', 'cancelled'].includes(session.flow.status)));
    },
    hasFixedWork(ticket) {
      const session = sessionFor(ticket);
      return Boolean(session?.workspace || session?.workspaceRequest || session?.assignment?.state === 'uncertain');
    },
    clearPlacement(ticket) {
      const session = sessionFor(ticket);
      if (session) delete session.placement;
    },
    syncTicket(ticket) {
      const session = sessionFor(ticket);
      if (session) {
        session.description = ticket.description;
        if (!session.conversationId) session.title = ticket.title;
      }
    },
    projection(ticket) {
      const session = sessionFor(ticket);
      return {
        runnerId: session?.runnerId,
        workflow: session?.workflow ? { id: session.workflow.id, name: session.workflow.name, version: session.workflow.version } : null,
        executionStatus: session?.status,
      };
    },
  };
}
