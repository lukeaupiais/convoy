import { randomUUID } from 'node:crypto';
import { createBoards } from './boards.mjs';
import { requiredText as text } from '../../shared/validation.mjs';
export const phases = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'];
export function createCatalog({ state, save, execution, externalTickets, contextFiles, referencedColumn, referencedBoard }) {
  state.projects ??= [{ id: 'agent-platform', organizationId: 'personal', name: 'Agent platform', description: '', revision: 1, placement: { mode: 'none' }, executionProfile: 'ask' }];
  for (const value of state.projects) value.organizationId ??= 'personal';
  state.tickets ??= []; state.ticketRequests ??= {};
  state.ticketDevelopmentLinks ??= [];
  state.ticketConnections ??= [];
  for (const value of state.ticketConnections) {
    value.enabled ??= true;
    value.capabilities ??= { import: true, create: value.provider === 'linear', update: value.provider === 'linear' };
  }
  for (const value of state.tickets) {
    value.origin ??= value.source === 'browser-import' ? 'browser-import' : value.source === 'session-migration' ? 'session-migration' : 'convoy';
    if (value.externalPublish?.state === 'pending') value.externalPublish.state = 'outcome-unknown';
  }
  const project = id => { const p = state.projects.find(p => p.id === id); if (!p) throw new Error('Project not found.'); return p; };
  const ticket = id => state.tickets.find(t => String(t.id) === String(id));
  const supportTicket = (id, revision) => {
    const value = ticket(id);
    if (!value || value.origin !== 'external') throw new Error('Imported support ticket not found.');
    if (value.revision !== revision) throw new Error('Support ticket changed in another client. Reload before linking.');
    return value;
  };
  const developmentTicket = id => {
    const value = ticket(id);
    if (!value || value.origin !== 'convoy') throw new Error('Development ticket not found.');
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
  const connection = id => {
    const value = state.ticketConnections.find(item => item.id === id);
    if (!value) throw new Error('Ticket connection not found.');
    return value;
  };
  const activeConnection = id => {
    const value = connection(id);
    if (!value.enabled) throw new Error('Ticket connection is disabled.');
    return value;
  };
  const normalizedRemote = item => item?.remoteId ? item : item && ({ remoteId: item.id, remoteKey: item.identifier, url: item.url, title: item.title, description: item.description ?? '', sourceScope: item.team?.id, fieldOwnership: { title: 'external', description: 'external' } });
  const normalizedRemotePage = remote => {
    const identities = new Set();
    return remote.map(item => {
      const normalized = normalizedRemote(item);
      if (!normalized?.remoteId || !normalized.remoteKey || !normalized.title) throw new Error('Ticket source returned an incomplete issue.');
      if (identities.has(normalized.remoteId)) throw new Error(`Ticket source returned duplicate remote identity: ${normalized.remoteId}.`);
      identities.add(normalized.remoteId);
      return normalized;
    });
  };
  const link = (source, remote) => {
    if (typeof remote.remoteId !== 'string' || !remote.remoteId || typeof remote.remoteKey !== 'string' || !remote.remoteKey) throw new Error('External issue identity is incomplete.');
    const fallbackUrl = source.provider === 'linear' ? `https://linear.app/issue/${encodeURIComponent(remote.remoteKey)}` : source.manifest?.connection?.baseUrl;
    const url = new URL(remote.url ?? fallbackUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('External issue URL is invalid.');
    if (source.provider === 'linear' && url.hostname !== 'linear.app') throw new Error('Linear issue URL is invalid.');
    return { connectionId: source.id, provider: source.provider, remoteId: remote.remoteId,
      remoteKey: remote.remoteKey, url: url.href, syncState: 'linked', ...(remote.remoteVersion ? { remoteVersion: remote.remoteVersion } : {}) };
  };
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
  async function publish(t, source, requestId) {
    if (!externalTickets) throw new Error('External ticket adapter is unavailable.');
    if (source.capabilities?.create === false) throw new Error('This ticket source is read-only.');
    if (t.externalLinks?.some(item => item.connectionId === source.id)) return t;
    if (t.externalLinks?.length) throw new Error('This ticket is already linked to an external issue.');
    if (t.externalPublish) throw new Error('A previous external creation needs reconciliation.');
    externalTickets.assertReady?.(source);
    t.externalPublish = { connectionId: source.id, requestId, state: 'pending' };
    await save();
    try {
      const remote = await externalTickets.createIssue(source, t);
      t.externalLinks = [...(t.externalLinks ?? []), { ...link(source, remote), remoteTitle: t.title, remoteDescription: t.description, fieldOwnership: { title: 'convoy', description: 'convoy' } }];
      delete t.externalPublish;
    } catch (error) {
      t.externalPublish = { connectionId: source.id, requestId, state: 'outcome-unknown', message: error.message };
    }
    t.revision++;
    await save();
    return t;
  }
  async function pushContent(t, externalLink) {
    const source = activeConnection(externalLink.connectionId);
    if (source.capabilities?.update === false) throw new Error('This ticket source is read-only.');
    if (!externalTickets?.updateIssue) throw new Error('External ticket update adapter is unavailable.');
    if (externalLink.fieldOwnership?.title !== 'convoy' || externalLink.fieldOwnership?.description !== 'convoy') throw new Error('This ticket has external-owned content.');
    externalLink.syncState = 'error';
    externalLink.message = 'Update pending; check Linear before retrying.';
    await save();
    try {
      const remote = await externalTickets.updateIssue(source, externalLink.remoteId, { title: t.title, description: t.description });
      externalLink.remoteTitle = remote.title;
      externalLink.remoteDescription = remote.description ?? '';
      externalLink.syncState = 'linked';
      delete externalLink.message;
    } catch (error) {
      externalLink.message = error.message;
    }
    t.revision++;
    await save();
    return t;
  }
  function assertEditable(t, queuedPlacement = false) { execution.assertEditable(t, queuedPlacement); }
  return {
    project, ticket, assertEditable, boards,
    async readAttachment(ticketId, attachmentId) {
      const t = ticket(ticketId); if (!t) throw new Error('Ticket not found.');
      return contextFiles.read(attachmentOwner(t), attachmentId);
    },
    async command(c) {
      if (c.action === 'saveTicketConnection') {
        const old = c.id ? connection(c.id) : null;
        if (old && c.revision !== old.revision) throw new Error('Ticket connection changed in another client.');
        if (old && old.organizationId !== c.organizationId) throw new Error('Connection organization cannot change.');
        if (old && old.provider !== c.provider) throw new Error('Connection provider cannot change.');
        if (!['linear', 'custom-http'].includes(c.provider)) throw new Error('Ticket connection provider is unsupported.');
        if (c.provider === 'linear') {
          if (old && old.teamId !== c.teamId && state.tickets.some(t => t.externalLinks?.some(value => value.connectionId === old.id))) throw new Error('A connection with linked tickets cannot change Linear teams.');
          if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(c.teamId)) throw new Error('Linear team ID must be a UUID.');
          if (!/^CONVOY_LINEAR_TOKEN_[A-Z0-9_]{1,60}$/.test(c.credentialEnv)) throw new Error('Credential environment variable must start with CONVOY_LINEAR_TOKEN_.');
        }
        const manifest = c.provider === 'custom-http' ? structuredClone(c.manifest) : undefined;
        if (c.provider === 'custom-http') {
          if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Custom ticket source manifest must be an object.');
          externalTickets?.validateConnection?.({ provider: c.provider, manifest });
        }
        if (old && c.provider === 'custom-http' && state.tickets.some(t => t.externalLinks?.some(value => value.connectionId === old.id))) {
          const identity = value => ({ ...value, values: undefined, mapping: { ...value.mapping, urlTemplate: undefined } });
          if (JSON.stringify(identity(old.manifest)) !== JSON.stringify(identity(manifest))) throw new Error('A connection with linked tickets can change value mappings only. Create another connection for a different source.');
        }
        if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw new Error('Connection enabled must be a boolean.');
        const providerFields = c.provider === 'linear' ? { teamId: c.teamId, credentialEnv: c.credentialEnv } : { manifest };
        const capabilities = { import: true, create: c.provider === 'linear', update: c.provider === 'linear' };
        const value = { id: old?.id ?? randomUUID(), organizationId: c.organizationId, provider: c.provider, name: text(c.name, 'Connection name', 100), ...providerFields, capabilities, enabled: c.enabled ?? old?.enabled ?? true, revision: (old?.revision ?? 0) + 1 };
        if (old) Object.assign(old, value); else state.ticketConnections.push(value);
        await save(); return value;
      }
      if (c.action === 'deleteTicketConnection') {
        const source = connection(c.id);
        if (c.revision !== source.revision) throw new Error('Ticket connection changed in another client.');
        if (state.boards?.some(board => board.destinationConnectionIds?.includes(source.id) || board.creationPolicy?.connectionId === source.id)) throw new Error('Remove this connection from boards before deleting it.');
        if (state.tickets.some(t => t.externalLinks?.some(value => value.connectionId === source.id) || t.externalPublish?.connectionId === source.id)) throw new Error('Connection has linked or pending tickets. Disable it instead.');
        state.ticketConnections = state.ticketConnections.filter(value => value.id !== source.id);
        await save(); return { id: source.id, deleted: true };
      }
      if (c.action === 'probeTicketConnection') {
        const source = connection(c.id);
        if (!externalTickets?.probe) throw new Error('External ticket probe is unavailable.');
        return externalTickets.probe(source);
      }
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
        const owner = project(c.projectId); const values = fields(c);
        const board = c.boardId ? boards.board(c.boardId) : null;
        if (board && !board.projectIds.includes(c.projectId)) throw new Error('Project is not available on this board.');
        const policy = board?.creationPolicy ?? { mode: 'convoy' };
        if (policy.mode === 'ask' && c.destination === undefined) throw new Error('Choose where to create this ticket.');
        const destination = c.destination ?? (policy.mode === 'connection' ? policy.connectionId : 'convoy');
        if (destination !== 'convoy' && !board) throw new Error('Choose a board before publishing externally.');
        const source = destination === 'convoy' ? null : activeConnection(destination);
        if (source && !board.destinationConnectionIds?.includes(source.id)) throw new Error('Destination is not enabled for this board.');
        if (source && source.organizationId !== owner.organizationId) throw new Error('Connection is not available to this project.');
        if (source && !externalTickets) throw new Error('External ticket adapter is unavailable.');
        if (source) externalTickets.assertReady?.(source);
        const id = Math.max(0, ...state.tickets.map(t => Number(t.id)), ...execution.reservedTicketIds()) + 1;
        if (id > 9999999999) throw new Error('Ticket ID range exhausted.');
        const value = { id, projectId: c.projectId, ...values, revision: 1, origin: 'convoy', placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
        if (board) boards.assertTicketVisible(board.id, value);
        boards.validateNewTicket(value);
        state.tickets.push(value); state.ticketRequests[request] = id; boards.ensureTicket(value); await save();
        return source ? publish(value, source, request) : value;
      }
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
        const value = { id, projectId: owner.id, ...fields({ title: c.title, description: c.description ?? '', status: 'Backlog' }), revision: 1, origin: 'convoy', placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
        boards.validateNewTicket(value);
        state.tickets.push(value);
        state.ticketRequests[request] = id;
        boards.ensureTicket(value);
        linkDevelopment(support, value);
        await save();
        return value;
      }
      if (c.action === 'linkDevelopmentTicket') {
        const support = supportTicket(c.supportTicketId, c.supportRevision);
        const development = developmentTicket(c.developmentTicketId);
        if (development.revision !== c.developmentRevision) throw new Error('Development ticket changed in another client. Reload before linking.');
        const value = linkDevelopment(support, development);
        await save();
        return value;
      }
      if (c.action === 'unlinkDevelopmentTicket') {
        const support = supportTicket(c.supportTicketId, c.supportRevision);
        const development = developmentTicket(c.developmentTicketId);
        const previous = state.ticketDevelopmentLinks.length;
        state.ticketDevelopmentLinks = state.ticketDevelopmentLinks.filter(value => value.supportTicketId !== support.id || value.developmentTicketId !== development.id);
        if (state.ticketDevelopmentLinks.length === previous) throw new Error('Development link not found.');
        support.revision++;
        await save();
        return { supportTicketId: support.id, developmentTicketId: development.id };
      }
      if (c.action === 'publishTicket') {
        const t = ticket(c.ticketId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client.');
        const source = activeConnection(c.connectionId);
        if (source.organizationId !== project(t.projectId).organizationId) throw new Error('Connection is not available to this project.');
        if (!state.boards.some(board => board.projectIds.includes(t.projectId) && board.destinationConnectionIds?.includes(source.id))) throw new Error('Connection is not enabled for this project.');
        return publish(t, source, text(c.requestId, 'Request ID', 100));
      }
      if (c.action === 'reconcileTicketPublish') {
        const t = ticket(c.ticketId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client.');
        if (t.externalPublish?.state !== 'outcome-unknown') throw new Error('No uncertain external creation to reconcile.');
        if (Boolean(c.remoteId) === Boolean(c.confirmNotCreated)) throw new Error('Provide a remote issue ID or confirm that no issue was created.');
        if (c.remoteId) {
          const source = connection(t.externalPublish.connectionId);
          if (!externalTickets) throw new Error('External ticket adapter is unavailable.');
          const remote = normalizedRemote(await externalTickets.getIssue(source, text(c.remoteId, 'Remote issue ID', 100)));
          if (!remote || source.provider === 'linear' && remote.sourceScope !== source.teamId) throw new Error('Issue was not found in the configured ticket source.');
          if (state.tickets.some(other => other.id !== t.id && other.externalLinks?.some(value => value.connectionId === source.id && value.remoteId === remote.remoteId))) throw new Error('External issue is already linked to another ticket.');
          t.externalLinks = [...(t.externalLinks ?? []), { ...link(source, remote), remoteTitle: remote.title, remoteDescription: remote.description ?? '', fieldOwnership: { title: 'convoy', description: 'convoy' } }];
        }
        delete t.externalPublish; t.revision++; await save(); return t;
      }
      if (c.action === 'previewExternalTickets') {
        const owner = project(c.projectId); const source = activeConnection(c.connectionId);
        if (source.organizationId !== owner.organizationId) throw new Error('Connection is not available to this project.');
        if (!externalTickets?.listIssues) throw new Error('External ticket adapter is unavailable.');
        const limit = c.limit ?? 10;
        if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Preview limit must be 1–25.');
        const remote = normalizedRemotePage(await externalTickets.listIssues(source, limit));
        let wouldImport = 0; let wouldUpdate = 0; let unchanged = 0;
        let sample;
        for (const normalized of remote) {
          sample ??= { remoteId: normalized.remoteId, remoteKey: normalized.remoteKey, title: normalized.title, description: normalized.description ?? '' };
          const existing = state.tickets.find(t => t.externalLinks?.some(value => value.connectionId === source.id && value.remoteId === normalized.remoteId));
          if (!existing) { wouldImport++; continue; }
          const previous = existing.externalLinks.find(value => value.connectionId === source.id && value.remoteId === normalized.remoteId);
          if (previous.remoteTitle !== normalized.title || previous.remoteDescription !== (normalized.description ?? '') || previous.remoteVersion !== normalized.remoteVersion) wouldUpdate++;
          else unchanged++;
        }
        return { wouldImport, wouldUpdate, unchanged, ...(sample ? { sample } : {}) };
      }
      if (c.action === 'importExternalTickets') {
        const owner = project(c.projectId); const source = activeConnection(c.connectionId);
        if (source.organizationId !== owner.organizationId) throw new Error('Connection is not available to this project.');
        if (!externalTickets) throw new Error('External ticket adapter is unavailable.');
        const limit = c.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Import limit must be 1–100.');
        const remote = normalizedRemotePage(await externalTickets.listIssues(source, limit));
        const planned = []; let imported = 0; let updated = 0;
        for (const normalized of remote) {
          const existing = state.tickets.find(t => t.externalLinks?.some(value => value.connectionId === source.id && value.remoteId === normalized.remoteId));
          const ownership = normalized.fieldOwnership ?? { title: 'external', description: 'external' };
          const remoteLink = { ...link(source, normalized), remoteTitle: normalized.title, remoteDescription: normalized.description ?? '', ...(normalized.status !== undefined ? { remoteStatus: normalized.rawStatus ?? normalized.status, mappedStatus: normalized.status } : {}), ...(normalized.priority !== undefined ? { remotePriority: normalized.rawPriority ?? normalized.priority, mappedPriority: normalized.priority } : {}), fieldOwnership: ownership };
          if (existing) {
            const previous = existing.externalLinks.find(value => value.connectionId === source.id && value.remoteId === normalized.remoteId);
            remoteLink.fieldOwnership = previous.fieldOwnership ?? remoteLink.fieldOwnership;
            const titleChanged = previous.remoteTitle !== normalized.title;
            const descriptionChanged = previous.remoteDescription !== (normalized.description ?? '');
            const previousStatus = previous.mappedStatus ?? previous.remoteStatus;
            const previousPriority = previous.mappedPriority ?? previous.remotePriority;
            const statusChanged = normalized.status !== undefined && previousStatus !== undefined && previousStatus !== normalized.status;
            const priorityChanged = normalized.priority !== undefined && previousPriority !== undefined && previousPriority !== normalized.priority;
            const changed = titleChanged || descriptionChanged || statusChanged || priorityChanged || previous.remoteVersion !== normalized.remoteVersion;
            const ownedByExternal = field => (remoteLink.fieldOwnership[field] ?? 'external') === 'external';
            const conflict = titleChanged && ownedByExternal('title') && existing.title !== previous.remoteTitle
              || descriptionChanged && ownedByExternal('description') && existing.description !== previous.remoteDescription
              || statusChanged && ownedByExternal('status') && previousStatus !== undefined && existing.status !== previousStatus
              || priorityChanged && ownedByExternal('priority') && previousPriority !== undefined && existing.priority !== previousPriority;
            const next = { ...existing, externalLinks: existing.externalLinks.map(value => value === previous ? remoteLink : value) };
            if (changed && conflict) {
              remoteLink.syncState = 'error'; remoteLink.message = 'Local and external content changed. Review this ticket.';
            } else if (changed) {
              if (titleChanged && ownedByExternal('title')) next.title = normalized.title;
              if (descriptionChanged && ownedByExternal('description')) next.description = normalized.description ?? '';
              if (statusChanged && ownedByExternal('status')) next.status = normalized.status;
              if (priorityChanged && ownedByExternal('priority')) next.priority = normalized.priority;
              next.revision++; updated++;
            }
            planned.push({ old: existing, next });
          } else {
            const id = Math.max(0, ...state.tickets.map(t => Number(t.id)), ...planned.map(v => Number(v.next.id)), ...execution.reservedTicketIds()) + 1;
            const next = { id, projectId: c.projectId, ...fields({ title: normalized.title, description: normalized.description ?? '', status: normalized.status, priority: normalized.priority }), revision: 1, origin: 'external', externalLinks: [remoteLink], placement: { mode: 'inherit' }, executionProfile: 'inherit', createdAt: new Date().toISOString() };
            planned.push({ next }); imported++;
          }
        }
        boards.validateTicketBatch(planned);
        for (const change of planned) {
          if (change.old) Object.assign(change.old, change.next);
          else { state.tickets.push(change.next); boards.ensureTicket(change.next); }
        }
        await save(); return { imported, updated };
      }
      if (c.action === 'syncExternalTicket') {
        const t = ticket(c.ticketId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client.');
        const externalLink = t.externalLinks?.find(value => value.connectionId === c.connectionId);
        if (!externalLink) throw new Error('External link not found.');
        if (c.resolution && !['local', 'remote'].includes(c.resolution)) throw new Error('Unknown sync resolution.');
        if (c.resolution === 'remote') {
          const ownership = externalLink.fieldOwnership ?? { title: 'external', description: 'external' };
          const patch = {};
          if ((ownership.title ?? 'external') === 'external' && externalLink.remoteTitle !== undefined) patch.title = externalLink.remoteTitle;
          if ((ownership.description ?? 'external') === 'external' && externalLink.remoteDescription !== undefined) patch.description = externalLink.remoteDescription;
          if ((ownership.status ?? 'external') === 'external' && (externalLink.mappedStatus ?? externalLink.remoteStatus) !== undefined) patch.status = externalLink.mappedStatus ?? externalLink.remoteStatus;
          if ((ownership.priority ?? 'external') === 'external' && (externalLink.mappedPriority ?? externalLink.remotePriority) !== undefined) patch.priority = externalLink.mappedPriority ?? externalLink.remotePriority;
          if (!Object.keys(patch).length) throw new Error('No observed external values are available to apply. Import the source again.');
          boards.validateTicketUpdate(t, patch);
          Object.assign(t, patch, { revision: t.revision + 1 });
          externalLink.syncState = 'linked'; delete externalLink.message;
          execution.syncTicket(t); await save(); return t;
        }
        if (c.resolution === 'local') {
          const source = activeConnection(c.connectionId);
          if (!source.capabilities?.update) throw new Error('This ticket source is read-only. Use its external values or edit the ticket at the source.');
          externalLink.fieldOwnership = { title: 'convoy', description: 'convoy', status: 'convoy', priority: 'convoy' };
        }
        return pushContent(t, externalLink);
      }
      if (c.action === 'updateTicket') {
        const t = ticket(c.taskId); if (!t) throw new Error('Ticket not found.'); if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before saving.');
        const patch = c.patch ?? {};
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['title', 'description', 'status', 'label', 'agent', 'priority', 'customFields'].includes(k))) throw new Error('Unsupported ticket fields. Use placement and workflow commands for execution settings.');
        for (const field of ['status', 'priority']) if (patch[field] !== undefined && patch[field] !== t[field] && t.externalLinks?.some(value => value.fieldOwnership?.[field] === 'external')) throw new Error(`This ticket's ${field} is owned by the external source.`);
        if (Object.keys(patch).some(k => !['status', 'priority', 'label'].includes(k))) assertEditable(t);
        const contentChanged = ['title', 'description'].some(key => patch[key] !== undefined && patch[key] !== t[key]);
        if (contentChanged && t.externalLinks?.some(value => value.fieldOwnership?.title === 'external' && patch.title !== undefined && patch.title !== t.title || value.fieldOwnership?.description === 'external' && patch.description !== undefined && patch.description !== t.description)) throw new Error('This content is owned by the external source. Edit it there, then import again.');
        if (contentChanged && t.externalLinks?.some(value => value.syncState === 'error')) throw new Error('Resolve the external sync issue before editing linked content.');
        boards.validateTicketUpdate(t, patch);
        const value = fields({ ...t, ...patch }); Object.assign(t, value, { revision: t.revision + 1 });
        boards.ensureTicket(t);
        execution.syncTicket(t); await save();
        const outgoing = contentChanged ? t.externalLinks?.find(item => item.fieldOwnership?.title === 'convoy' && item.fieldOwnership?.description === 'convoy') : null;
        return outgoing ? pushContent(t, outgoing) : t;
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
    snapshot() { return { projects: state.projects, tickets: state.tickets.map(t => ({ ...t, status: t.status, ...execution.projection(t) })), ticketConnections: state.ticketConnections, ticketDevelopmentLinks: state.ticketDevelopmentLinks, ...boards.snapshot() }; },
  };
}
