import { randomUUID } from 'node:crypto';
import { requiredText as text } from '../../shared/validation.mjs';

export function createConversations({ state, catalog, save, event, makeSession, busy, start, pinInstructions, validateBinding, authorizeStart, initializeWorkspace = () => {}, ticketCommand = command => catalog.command(command) }) {
  state.conversations ??= [];
  state.conversationRequests ??= {};
  for (const s of Object.values(state.sessions)) {
    if (s.activeTicketId === undefined) s.activeTicketId = catalog.ticket(s.id)?.id ?? null;
    s.projectId ??= catalog.ticket(s.activeTicketId)?.projectId;
    let c = state.conversations.find(c => c.sessionId === s.id);
    if (!c) { c = { id: s.id.startsWith('chat-') ? s.id : `chat-legacy-${s.id}`, sessionId: s.id, title: s.title, projectId: s.projectId, linkedTicketIds: s.activeTicketId ? [s.activeTicketId] : [], createdAt: s.updatedAt }; state.conversations.push(c); }
    s.conversationId = c.id;
    if (s.activeTicketId) catalog.ticket(s.activeTicketId).executionSessionId = s.id;
  }
  const conversation = id => { const c = state.conversations.find(c => c.id === id); if (!c) throw new Error('Conversation not found.'); return c; };
  const ticket = id => { const t = catalog.ticket(id); if (!t) throw new Error('Ticket not found.'); return t; };
  const sessionFor = value => { const session = value ? state.sessions[value.executionSessionId ?? String(value.id)] : undefined; return session && (session.activeTicketId === undefined || session.activeTicketId === value.id) ? session : undefined; };
  const current = s => conversation(s.conversationId);
  function link(s, id) { const t = ticket(id); const c = current(s); if (!c.linkedTicketIds.includes(t.id)) { c.linkedTicketIds.push(t.id); event(s, 'ticket_linked', { ticketId: t.id, title: t.title }); } return t; }
  function idle(s) { if (busy(s) || s.queuedInput || s.flow && !['completed', 'cancelled'].includes(s.flow.status)) throw new Error('Finish, stop, or cancel the active work before changing assignment.'); if (s.assignment?.state === 'uncertain') throw new Error('Reconcile the uncertain execution before changing assignment.'); }
  function bind(s, t) {
    if (s.activeTicketId && s.activeTicketId !== t.id) throw new Error('This session already has an active assignment. Release it before taking another ticket.');
    const other = sessionFor(t);
    if (other && other.id !== s.id && other.activeTicketId === t.id) throw new Error('Ticket is already assigned to another session.');
    if (s.projectId && s.projectId !== t.projectId) throw new Error('This session retains another project’s context. Delegate to a new session instead.');
    validateBinding(s, t);
    s.projectId = t.projectId; s.activeTicketId = t.id; t.executionSessionId = s.id; t.agent = 'Convoy'; t.revision++;
    current(s).projectId = s.projectId; link(s, t.id);
    // Keep the same message history and worktree; refresh only the assignment context.
    if (!s.workspace && !s.workspaceRequest && !(s.chatWorkspaceSelected && s.placement?.mode === 'pinned')) delete s.placement;
    pinInstructions(s);
    event(s, 'ticket_assigned', { ticketId: t.id, title: t.title }); return t;
  }
  async function create(c) {
    const requestId = text(c.requestId, 'Request ID', 100);
    const fingerprint = JSON.stringify({ projectId: c.projectId || null, title: c.title || 'New chat', placement: c.placement ?? null });
    if (Object.hasOwn(state.conversationRequests, requestId)) {
      const existing = conversation(state.conversationRequests[requestId]);
      if (existing.creationFingerprint && existing.creationFingerprint !== fingerprint) throw new Error('This request already created a chat with different settings. Use a new request ID.');
      return existing;
    }
    if (c.projectId) catalog.project(c.projectId);
    const id = `chat-${randomUUID()}`;
    const value = { id, sessionId: id, title: text(c.title || 'New chat', 'Conversation title', 200), projectId: c.projectId || null, linkedTicketIds: [], createdAt: new Date().toISOString() };
    const s = makeSession(id, value.title); Object.assign(s, { conversationId: id, projectId: value.projectId, activeTicketId: null });
    initializeWorkspace(s, c);
    value.creationFingerprint = fingerprint;
    state.sessions[id] = s; state.conversations.push(value); state.conversationRequests[requestId] = id; pinInstructions(s); await save(); return value;
  }
  return {
    conversation, current, create, sessionFor,
    bindForWorkflow(s, id) { idle(s); return bind(s, ticket(id)); },
    adopt(s) {
      if (s.conversationId) return current(s);
      const t = ticket(s.id); s.activeTicketId = t.id; s.projectId = t.projectId; t.executionSessionId = s.id;
      const c = { id: `chat-legacy-${s.id}`, sessionId: s.id, title: s.title, projectId: t.projectId, linkedTicketIds: [t.id], createdAt: s.updatedAt };
      s.conversationId = c.id; state.conversations.push(c); return c;
    },
    async action(s, c, fromAgent = false) {
      if (c.action === 'linkTicket') { const t = link(s, c.ticketId); await save(); return t; }
      if (c.action === 'rememberContext') { const summary = text(c.summary, 'Context summary', 12000); s.workingContext = summary; event(s, 'context_checkpoint', { summary }); await save(); return { saved: true }; }
      if (c.action === 'releaseTicket') {
        if (!fromAgent) idle(s);
        else if (s.flow && !['completed', 'cancelled'].includes(s.flow.status) || s.assignment?.state === 'uncertain') throw new Error('Finish the workflow or reconcile uncertain execution before releasing.');
        const t = ticket(s.activeTicketId);
        // Assignment ownership is independent of board placement and ticket status.
        t.revision++;
        s.activeTicketId = null;
        if (s.flow) { s.pastRuns ??= []; s.pastRuns.push({ ...s.flow, ticketId: t.id, workflow: s.workflow }); }
        s.flow = null; s.workflow = null; s.step = 0; delete s.boardPhase;
        pinInstructions(s); event(s, 'ticket_released', { ticketId: t.id }); await save(); return t;
      }
      if (c.action !== 'requestExecution') throw new Error('Unknown conversation action.');
      if (!['continue', 'delegate', 'queue'].includes(c.mode)) throw new Error('Choose continue, delegate, or queue.');
      const t = ticket(c.ticketId);
      if (c.mode === 'queue') { if (sessionFor(t)) throw new Error('Ticket is already assigned. Leaving it queued does not stop another agent.'); link(s, t.id); await save(); return { ticketId: t.id, started: false, mode: 'queue' }; }
      const brief = text(c.brief, 'Execution brief', 12000);
      await authorizeStart(s);
      if (c.mode === 'continue') {
        if (c.requestId && s.requests.includes(c.requestId) && s.activeTicketId === t.id) return { ticketId: t.id, sessionId: s.id, existing: true };
        if (s.activeTicketId && s.activeTicketId !== t.id) throw new Error('This session already has an active assignment. Release it before taking another ticket.');
        if (!fromAgent) idle(s);
        bind(s, t); await save();
        if (!fromAgent) await start(s, brief, c.requestId ?? randomUUID());
        return { ticketId: t.id, sessionId: s.id, mode: 'continue', message: 'Same session and history retained. Workspace tools become available after placement succeeds.' };
      }
      const existing = sessionFor(t);
      if (existing?.activeTicketId === t.id) {
        if (existing.parentSessionId === s.id) return { ticketId: t.id, sessionId: existing.id, conversationId: existing.conversationId, mode: 'delegate', existing: true };
        throw new Error('Ticket is already assigned. Release its existing assignment before delegating.');
      }
      const childConversation = await create({ title: t.title, projectId: t.projectId, requestId: `delegate-${s.id}-${t.id}-${c.requestId ?? randomUUID()}`.slice(0, 100) });
      const child = state.sessions[childConversation.sessionId];
      child.parentSessionId = s.id; child.model = s.model;
      const handoff = `Ticket CVY-${t.id}: ${t.title}\n${t.description}\n\nHandoff from conversation ${current(s).id}:\n${brief}\n\nNo source worktree has been transferred. Verify any referenced files in your own assigned environment. Report results and limitations; completion is not acceptance.`;
      child.workingContext = handoff;
      bind(child, t); link(s, t.id); event(s, 'ticket_delegated', { ticketId: t.id, sessionId: child.id, conversationId: childConversation.id, brief }); await save();
      await start(child, handoff, c.requestId ?? randomUUID());
      return { ticketId: t.id, sessionId: child.id, conversationId: childConversation.id, mode: 'delegate' };
    },
    async tool(s, name, args, callId) {
      if (name === 'list_work') {
        const work = catalog.snapshot();
        return {
          projects: state.projects.map(({ id, name }) => ({ id, name })),
          tickets: work.tickets.map(({ id, projectId, title, description, status, revision, executionSessionId }) => ({ id, projectId, title, description, status, revision, executionSessionId })),
          boards: work.boards.map(({ id, name, grouping, columns, tickets }) => ({
            id, name, grouping,
            columns: columns.map(({ id: columnId, name: columnName, value }) => ({ id: columnId, name: columnName, ...(value === undefined ? {} : { value }) })),
            placements: tickets.map(({ ticketId, columnId }) => ({ ticketId, columnId })),
          })),
        };
      }
      if (name === 'create_ticket') { const t = await ticketCommand(s, { action: 'createTicket', ...args, requestId: `${s.id}-${text(args.requestKey, 'Request key', 40)}`, agent: 'Unassigned', status: 'Backlog' }); link(s, t.id); await save(); return t; }
      if (name === 'update_ticket') { const t = await ticketCommand(s, { action: 'updateTicket', taskId: args.ticketId, revision: args.revision, patch: { title: args.title, description: args.description } }); link(s, t.id); await save(); return t; }
      if (name === 'move_ticket') return ticketCommand(s, { action: 'setBoardPlacement', boardId: args.boardId, ticketId: args.ticketId, revision: args.revision, placement: { columnId: args.columnId, swimlaneKey: null } });
      return this.action(s, { ...args, requestId: callId, action: { link_ticket: 'linkTicket', request_execution: 'requestExecution', remember_context: 'rememberContext', release_assignment: 'releaseTicket' }[name] }, true);
    },
    async notify(s) {
      if (!s.parentSessionId || ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(s.status)) return;
      const parent = state.sessions[s.parentSessionId]; if (!parent) return;
      const message = s.events.findLast(e => e.type === 'assistant')?.text ?? s.status;
      event(parent, 'delegation_result', { ticketId: s.activeTicketId, sessionId: s.id, conversationId: s.conversationId, status: s.status, summary: message.slice(0, 12000) }); await save();
    },
    snapshot() { return { conversations: state.conversations.map(c => ({ ...c, updatedAt: state.sessions[c.sessionId]?.updatedAt, activeTicketId: state.sessions[c.sessionId]?.activeTicketId })) }; },
  };
}
