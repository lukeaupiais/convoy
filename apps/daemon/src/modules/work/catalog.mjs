import { randomUUID } from 'node:crypto';
import { createBoards } from './boards.mjs';
import { requiredText as text } from '../../shared/validation.mjs';
export const phases = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'];
export function createCatalog({ state, save, execution, contextFiles, referencedColumn, referencedBoard }) {
  state.projects ??= [{ id: 'agent-platform', organizationId: 'personal', name: 'Agent platform', description: '', revision: 1, placement: { mode: 'none' }, executionProfile: 'ask' }];
  for (const value of state.projects) value.organizationId ??= 'personal';
  state.tickets ??= []; state.ticketRequests ??= {};
  const project = id => { const p = state.projects.find(p => p.id === id); if (!p) throw new Error('Project not found.'); return p; };
  const ticket = id => state.tickets.find(t => String(t.id) === String(id));
  const attachmentOwner = t => ({
    id: `ticket-${t.id}`,
    contextFiles: Object.fromEntries((t.attachments ?? []).map(file => [file.id, file])),
  });
  const customFields = input => {
    if (input === undefined) return {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 50) throw new Error('Custom fields must be an object with at most 50 entries.');
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (!/^[\w-]{1,80}$/.test(key) || typeof value === 'object' && value !== null || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('Custom field names or values are invalid.');
      if (typeof value === 'string' && value.length > 4000) throw new Error('Custom field text is too long.');
      result[key] = value;
    }
    return result;
  };
  function fields(input) {
    const value = { title: text(input.title, 'Title', 200), description: text(input.description ?? '', 'Description', 12000, true), status: text(input.status ?? 'Backlog', 'Status', 80), label: text(input.label ?? 'Core', 'Label', 80), agent: text(input.agent ?? 'Unassigned', 'Agent', 80), priority: input.priority ?? 'Medium', customFields: customFields(input.customFields) };
    if (!['Low', 'Medium', 'High'].includes(value.priority)) throw new Error('Invalid status or priority.'); return value;
  }
  for (const seed of execution.legacyTicketSeeds()) if (!ticket(seed.id)) state.tickets.push({ id: seed.id, projectId: state.projects[0].id, ...fields({ agent: 'Convoy', ...seed }), revision: 1, source: 'session-migration', placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: seed.createdAt });
  if (state.ticketStatusMigrationVersion === undefined) {
    // Preserve the old phase projection once while migrating. Thereafter workflow
    // runs and ticket status are independent; snapshot never projects boardPhase.
    for (const t of state.tickets) {
      const status = execution.migratedStatus(t);
      if (status && phases.includes(status)) t.status = status;
    }
    state.ticketStatusMigrationVersion = 1;
  }
  const boards = createBoards({ state, save, projects: state.projects, ticket, referencedColumn, referencedBoard });
  function assertEditable(t, queuedPlacement = false) { execution.assertEditable(t, queuedPlacement); }
  return {
    project, ticket, assertEditable, boards,
    async readAttachment(ticketId, attachmentId) {
      const t = ticket(ticketId); if (!t) throw new Error('Ticket not found.');
      return contextFiles.read(attachmentOwner(t), attachmentId);
    },
    async command(c) {
      if (c.action === 'saveProject') {
        const old = c.id ? project(c.id) : null;
        if (old && c.revision !== old.revision) throw new Error('Project changed in another client. Reload before saving.');
        if (old && c.organizationId && c.organizationId !== old.organizationId) throw new Error('A project cannot move between organizations.');
        const value = { ...(old ?? { id: randomUUID(), organizationId: c.organizationId ?? 'personal', ...(c.teamId ? { teamId: c.teamId } : {}), placement: { mode: 'none' }, executionProfile: 'ask' }), name: text(c.name, 'Project name', 100), description: text(c.description ?? '', 'Description', 4000, true), revision: (old?.revision ?? 0) + 1 };
        if (old) Object.assign(old, value); else state.projects.push(value); await save(); return value;
      }
      if (c.action === 'createTicket') {
        const request = text(c.requestId, 'Request ID', 100); if (!/^[\w-]+$/.test(request)) throw new Error('Invalid request ID.');
        if (Object.hasOwn(state.ticketRequests, request)) return ticket(state.ticketRequests[request]);
        project(c.projectId); const values = fields(c);
        const id = Math.max(0, ...state.tickets.map(t => Number(t.id)), ...execution.reservedTicketIds()) + 1;
        if (id > 9999999999) throw new Error('Ticket ID range exhausted.');
        const value = { id, projectId: c.projectId, ...values, revision: 1, placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
        boards.validateNewTicket(value);
        state.tickets.push(value); state.ticketRequests[request] = id; boards.ensureTicket(value); await save(); return value;
      }
      if (c.action === 'updateTicket') {
        const t = ticket(c.taskId); if (!t) throw new Error('Ticket not found.'); if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before saving.');
        const patch = c.patch ?? {};
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['title', 'description', 'status', 'label', 'agent', 'priority', 'customFields'].includes(k))) throw new Error('Unsupported ticket fields. Use placement and workflow commands for execution settings.');
        if (Object.keys(patch).some(k => !['status', 'priority', 'label'].includes(k))) assertEditable(t);
        boards.validateTicketUpdate(t, patch);
        const value = fields({ ...t, ...patch }); Object.assign(t, value, { revision: t.revision + 1 });
        boards.ensureTicket(t);
        execution.syncTicket(t); await save(); return t;
      }
      if (c.action === 'attachTicketFile') {
        const t = ticket(c.taskId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before saving.');
        assertEditable(t);
        const owner = attachmentOwner(t);
        await contextFiles.add(owner, c);
        t.attachments = Object.values(owner.contextFiles);
        t.revision++;
        execution.syncTicket(t); await save(); return t;
      }
      if (c.action === 'removeTicketFile') {
        const t = ticket(c.taskId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before saving.');
        assertEditable(t);
        if (!(t.attachments ?? []).some(file => file.id === c.attachmentId)) throw new Error('Attachment not found.');
        t.attachments = t.attachments.filter(file => file.id !== c.attachmentId);
        t.revision++;
        execution.syncTicket(t); await save(); return t;
      }
      if (c.action === 'importTickets') {
        project(c.projectId); if (!Array.isArray(c.tickets) || c.tickets.length > 200) throw new Error('Import up to 200 browser tickets at a time.');
        const incoming = c.tickets.map(t => { if (!Number.isSafeInteger(t.id) || t.id < 1 || t.id > 9999999999) throw new Error('Invalid imported ticket ID.'); return { id: t.id, ...fields(t) }; });
        let imported = 0; const conflicts = []; const planned = []; const seen = new Set();
        for (const value of incoming) {
          if (seen.has(value.id)) throw new Error(`Duplicate imported ticket ID ${value.id}.`);
          seen.add(value.id);
          const old = ticket(value.id);
          if (old) {
            if (old.source !== 'session-migration' || old.title !== value.title || old.projectId !== c.projectId || execution.isBusy(old)) { conflicts.push(value.id); continue; }
            const next = { ...old, ...value, projectId: old.projectId, customFields: Object.keys(value.customFields).length ? value.customFields : old.customFields ?? {} };
            planned.push({ old, next });
          } else {
            const next = { ...value, projectId: c.projectId, revision: 1, source: 'browser-import', placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
            planned.push({ next });
          }
        }
        // Validate the complete final ticket set before changing tickets, placements,
        // or linked session metadata. A rejected batch leaves state untouched.
        boards.validateTicketBatch(planned);
        for (const change of planned) {
          if (change.old) { Object.assign(change.old, change.next, { revision: change.old.revision + 1, source: 'browser-import' }); boards.ensureTicket(change.old); execution.syncTicket(change.old); }
          else { state.tickets.push(change.next); boards.ensureTicket(change.next); }
          imported++;
        }
        await save(); return { imported, conflicts };
      }
      if (['saveBoard', 'deleteBoard', 'saveBoardTemplate', 'deleteBoardTemplate', 'createBoardFromTemplate', 'setBoardPlacement', 'clearBoardPlacement'].includes(c.action)) return boards.command(c);
      throw new Error('Unknown catalog command.');
    },
    snapshot() { return { projects: state.projects, tickets: state.tickets.map(t => ({ ...t, status: t.status, ...execution.projection(t) })), ...boards.snapshot() }; },
  };
}
