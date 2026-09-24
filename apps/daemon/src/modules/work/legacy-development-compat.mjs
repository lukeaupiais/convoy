import { requiredText as text } from '../../shared/validation.mjs';

// Persisted commands and published workflow graphs from the former support /
// development model must remain executable. New code uses ticket relations.
export function migrateLegacyDevelopmentLinks(state) {
  state.ticketDevelopmentLinks ??= [];
  state.ticketRelations ??= [];
  for (const legacy of state.ticketDevelopmentLinks) {
    const id = `legacy:${legacy.id}`;
    if (!state.ticketRelations.some(value => value.id === id)) state.ticketRelations.push({
      id, sourceTicketId: legacy.supportTicketId, targetTicketId: legacy.developmentTicketId,
      kind: 'legacy-development', createdAt: legacy.createdAt,
    });
  }
}

export function createLegacyDevelopmentCommands({ state, ticket, project, fields, boards, execution, save, linkTickets }) {
  const supportTicket = (id, revision) => {
    const value = ticket(id);
    if (!value || (value.workType ?? (value.origin === 'external' ? 'support' : 'task')) !== 'support') throw new Error('Imported support ticket not found.');
    if (value.revision !== revision) throw new Error('Support ticket changed in another client. Reload before linking.');
    return value;
  };
  const developmentTicket = id => {
    const value = ticket(id);
    if (!value || (value.workType ?? (value.origin === 'convoy' ? 'development' : 'task')) !== 'development') throw new Error('Development ticket not found.');
    return value;
  };
  const linkDevelopment = (support, development) => {
    if (support.id === development.id || support.projectId !== development.projectId) throw new Error('Development work must belong to the same project as its support ticket.');
    const existing = state.ticketDevelopmentLinks.find(value => value.supportTicketId === support.id && value.developmentTicketId === development.id);
    if (existing) return existing;
    const value = { id: `${support.id}:${development.id}`, supportTicketId: support.id, developmentTicketId: development.id, createdAt: new Date().toISOString() };
    state.ticketDevelopmentLinks.push(value);
    support.revision++;
    return value;
  };
  return async c => {
    if (c.action === 'createDevelopmentTicket') {
      const request = text(c.requestId, 'Request ID', 100);
      if (!/^[\w-]+$/.test(request)) throw new Error('Invalid request ID.');
      const existingId = state.ticketRequests[request];
      if (existingId) {
        const existing = developmentTicket(existingId);
        if (!state.ticketDevelopmentLinks.some(value => value.supportTicketId === c.supportTicketId && value.developmentTicketId === existing.id)) throw new Error('Request ID belongs to a different ticket.');
        return existing;
      }
      const support = supportTicket(c.supportTicketId, c.supportRevision);
      const owner = project(c.projectId);
      if (owner.id !== support.projectId) throw new Error('Development work must belong to the support project.');
      const id = Math.max(0, ...state.tickets.map(t => Number(t.id)), ...execution.reservedTicketIds()) + 1;
      if (id > 9999999999) throw new Error('Ticket ID range exhausted.');
      const value = { id, projectId: owner.id, ...fields({ title: c.title, description: c.description ?? '', status: 'Backlog' }), revision: 1, origin: 'convoy', workType: 'development', placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
      boards.validateNewTicket(value);
      state.tickets.push(value);
      state.ticketRequests[request] = id;
      boards.ensureTicket(value);
      linkDevelopment(support, value);
      linkTickets(support, value, 'legacy-development', false);
      await save();
      return value;
    }
    if (c.action === 'linkDevelopmentTicket') {
      const support = supportTicket(c.supportTicketId, c.supportRevision);
      const development = developmentTicket(c.developmentTicketId);
      if (development.revision !== c.developmentRevision) throw new Error('Development ticket changed in another client. Reload before linking.');
      const value = linkDevelopment(support, development);
      linkTickets(support, development, 'legacy-development', false);
      await save();
      return value;
    }
    const support = supportTicket(c.supportTicketId, c.supportRevision);
    const development = developmentTicket(c.developmentTicketId);
    const previous = state.ticketDevelopmentLinks.length;
    state.ticketDevelopmentLinks = state.ticketDevelopmentLinks.filter(value => value.supportTicketId !== support.id || value.developmentTicketId !== development.id);
    if (state.ticketDevelopmentLinks.length === previous) throw new Error('Development link not found.');
    support.revision++;
    state.ticketRelations = state.ticketRelations.filter(value => !(value.sourceTicketId === support.id && value.targetTicketId === development.id && value.kind === 'legacy-development'));
    await save();
    return { supportTicketId: support.id, developmentTicketId: development.id };
  };
}
