import { randomUUID } from 'node:crypto';

// Board configuration is deliberately independent from execution and workflow state.
// A ticket can have a placement on any number of boards without being duplicated.
const colours = ['teal', 'blue', 'amber', 'violet', 'rose', 'slate'];
const modes = new Set(['local', 'field']);
const groupingFields = new Set(['status', 'priority', 'label', 'agent']);
const safeId = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][\w-]{0,79}$/.test(value)) throw new Error(`${label} must be a stable ID.`);
  return value;
};
const requiredText = (value, label, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
};
const optionalText = (value, label, max = 4000) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return value.trim();
};
const uniqueList = (value, label, max = 100) => {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 120)) throw new Error(`${label} must be a list of names or IDs.`);
  return [...new Set(value.map(x => x.trim()))];
};
const clone = value => structuredClone(value);

function colour(value, index) {
  if (value === undefined) return colours[index % colours.length];
  if (typeof value !== 'string' || !(/^[\w-]{1,30}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value))) throw new Error('Column colour is invalid.');
  return value;
}

function columns(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) throw new Error('A board requires 1–40 columns.');
  const ids = new Set();
  return input.map((original, index) => {
    const id = safeId(original?.id ?? `column-${index + 1}`, 'Column ID');
    if (ids.has(id)) throw new Error(`Column ID ${id} is duplicated.`);
    ids.add(id);
    const value = { id, name: requiredText(original?.name, `Column ${index + 1} name`), color: colour(original?.color, index), wipLimit: null };
    if (original?.wipLimit !== undefined && original.wipLimit !== null) {
      if (!Number.isSafeInteger(original.wipLimit) || original.wipLimit < 0 || original.wipLimit > 10000) throw new Error(`${value.name}: WIP limit must be 1–10000 or empty.`);
      value.wipLimit = original.wipLimit || null;
    }
    if (original?.value !== undefined) value.value = requiredText(original.value, `${value.name} field value`, 200);
    return value;
  });
}

function swimlanes(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Swimlane configuration is invalid.');
  const mode = input.mode ?? 'none';
  if (!['none', 'project', 'agent', 'priority', 'field'].includes(mode)) throw new Error('Unknown swimlane mode.');
  const result = { mode };
  if (mode === 'field') {
    if (typeof input.field !== 'string' || (!groupingFields.has(input.field) && !/^custom\.[\w-]{1,60}$/.test(input.field))) throw new Error('Swimlane field is invalid.');
    result.field = input.field;
  }
  if (input.values !== undefined) result.values = uniqueList(input.values, 'Swimlane values', 100);
  return result;
}

function filters(input = {}, projectIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Board filters are invalid.');
  const result = {};
  if (input.projectIds !== undefined) {
    result.projectIds = uniqueList(input.projectIds, 'Project filters');
    if (projectIds && result.projectIds.some(id => !projectIds.includes(id))) throw new Error('Board filter contains an unavailable project.');
  }
  for (const key of ['statuses', 'labels', 'agents', 'priorities']) if (input[key] !== undefined) result[key] = uniqueList(input[key], `Filter ${key}`, 100);
  if (input.query !== undefined) result.query = optionalText(input.query, 'Board query', 200);
  return result;
}

function boardInput(input, projects, old) {
  const projectIds = uniqueList(input.projectIds ?? projects.map(p => p.id), 'Board projects');
  const knownProjects = new Set(projects.map(p => p.id));
  if (projectIds.some(id => !knownProjects.has(id))) throw new Error('Board contains an unknown project.');
  const value = {
    id: old?.id ?? safeId(input.id ?? randomUUID(), 'Board ID'),
    name: requiredText(input.name, 'Board name'),
    description: optionalText(input.description, 'Board description'),
    projectIds,
    columns: columns(input.columns),
    swimlanes: swimlanes(input.swimlanes),
    filters: filters(input.filters, projectIds.length ? projectIds : projects.map(p => p.id)),
    cardFields: uniqueList(input.cardFields ?? ['priority', 'label', 'agent', 'project'], 'Card fields', 30),
    grouping: { mode: input.grouping?.mode ?? 'local' },
    density: input.density ?? 'comfortable',
    revision: (old?.revision ?? 0) + 1,
  };
  if (!['compact', 'comfortable', 'spacious'].includes(value.density)) throw new Error('Board density must be compact, comfortable or spacious.');
  if (!modes.has(value.grouping.mode)) throw new Error('Board grouping must be local or field-backed.');
  if (value.grouping.mode === 'field') {
    const field = input.grouping?.field;
    if (typeof field !== 'string' || (!groupingFields.has(field) && !/^custom\.[\w-]{1,60}$/.test(field))) throw new Error('Field-backed grouping needs a supported field.');
    value.grouping.field = field;
    value.columns.forEach(column => { if (column.value === undefined) column.value = old?.columns.find(previous => previous.id === column.id)?.value ?? old?.columns.find(previous => previous.id === column.id)?.name ?? column.name; });
    const fieldValues = value.columns.map(column => column.value ?? column.name);
    if (new Set(fieldValues).size !== fieldValues.length) throw new Error('Field-backed columns need distinct values.');
  }
  return value;
}

function templateInput(input, old) {
  const value = {
    id: old?.id ?? safeId(input.id ?? randomUUID(), 'Template ID'),
    name: requiredText(input.name, 'Board template name'),
    description: optionalText(input.description, 'Board template description'),
    columns: columns(input.columns),
    swimlanes: swimlanes(input.swimlanes),
    filters: filters(input.filters),
    cardFields: uniqueList(input.cardFields ?? ['priority', 'label', 'agent', 'project'], 'Card fields', 30),
    grouping: { mode: input.grouping?.mode ?? 'local' },
    density: input.density ?? 'comfortable',
    revision: (old?.revision ?? 0) + 1,
  };
  if (!['compact', 'comfortable', 'spacious'].includes(value.density)) throw new Error('Template density must be compact, comfortable or spacious.');
  if (!modes.has(value.grouping.mode)) throw new Error('Template grouping must be local or field-backed.');
  if (value.grouping.mode === 'field') {
    const field = input.grouping?.field;
    if (typeof field !== 'string' || (!groupingFields.has(field) && !/^custom\.[\w-]{1,60}$/.test(field))) throw new Error('Field-backed grouping needs a supported field.');
    value.grouping.field = field;
    value.columns.forEach(column => { if (column.value === undefined) column.value = old?.columns.find(previous => previous.id === column.id)?.value ?? old?.columns.find(previous => previous.id === column.id)?.name ?? column.name; });
    const fieldValues = value.columns.map(column => column.value ?? column.name);
    if (new Set(fieldValues).size !== fieldValues.length) throw new Error('Field-backed columns need distinct values.');
  }
  return value;
}

function defaultBoard(projects) {
  return {
    id: 'default-board', name: 'Project board', description: 'The editable board created from the original ticket phases.',
    projectIds: projects.map(p => p.id),
    columns: [
      { id: 'column-backlog', name: 'Backlog', color: 'slate', wipLimit: null },
      { id: 'column-ready', name: 'Ready', color: 'blue', wipLimit: null },
      { id: 'column-in-progress', name: 'In progress', color: 'teal', wipLimit: null },
      { id: 'column-in-review', name: 'In review', color: 'amber', wipLimit: null },
      { id: 'column-done', name: 'Done', color: 'violet', wipLimit: null },
    ],
    swimlanes: { mode: 'none' }, filters: {}, cardFields: ['priority', 'label', 'agent', 'project'], grouping: { mode: 'local' }, revision: 1,
    density: 'comfortable',
  };
}

function defaultTemplates() {
  return [
    { id: 'software-delivery', name: 'Software delivery', description: 'A lightweight flow for shipping changes.', columns: [{ id: 'backlog', name: 'Backlog', color: 'slate' }, { id: 'ready', name: 'Ready', color: 'blue' }, { id: 'doing', name: 'Doing', color: 'teal' }, { id: 'review', name: 'Review', color: 'amber' }, { id: 'done', name: 'Done', color: 'violet' }], swimlanes: { mode: 'none' }, filters: {}, cardFields: ['priority', 'label', 'agent', 'project'], grouping: { mode: 'local' }, density: 'comfortable', revision: 1 },
    { id: 'research', name: 'Research', description: 'Capture questions, evidence and decisions.', columns: [{ id: 'questions', name: 'Questions', color: 'blue' }, { id: 'investigating', name: 'Investigating', color: 'teal' }, { id: 'synthesising', name: 'Synthesising', color: 'amber' }, { id: 'complete', name: 'Complete', color: 'violet' }], swimlanes: { mode: 'none' }, filters: {}, cardFields: ['priority', 'label', 'agent', 'project'], grouping: { mode: 'local' }, density: 'comfortable', revision: 1 },
  ];
}

const phaseColumn = status => ({ Backlog: 'column-backlog', Ready: 'column-ready', 'In progress': 'column-in-progress', 'In review': 'column-in-review', Done: 'column-done' }[status] ?? 'column-backlog');

export function createBoards({ state, save, projects, ticket, referencedColumn = () => false, referencedBoard = () => false }) {
  state.boards ??= [];
  state.boardTemplates ??= [];
  state.boardPlacements ??= {};
  // This migration is additive and idempotent. Existing ticket IDs/statuses remain authoritative.
  if (state.boardMigrationVersion === undefined) {
    // The first migration is additive. Thereafter users may rename or delete any board,
    // including this starter board, without it being recreated on daemon restart.
    if (!state.boards.length) state.boards.unshift(defaultBoard(projects));
    state.boardMigrationVersion = 1;
  }
  if (state.boardTemplateMigrationVersion === undefined) {
    if (!state.boardTemplates.length) state.boardTemplates.push(...defaultTemplates());
    state.boardTemplateMigrationVersion = 1;
  }
  const defaultValue = state.boards.find(board => board.id === 'default-board');
  const workflowReferencesColumn = (boardId, columnId) => referencedColumn(boardId, columnId);
  const workflowReferencesBoard = boardId => referencedBoard(boardId);
  function ensureTicket(value) {
    const placements = state.boardPlacements[String(value.id)] ??= {};
    if (defaultValue) {
      const preferred = phaseColumn(value.status);
      const columnId = defaultValue.columns.some(column => column.id === preferred) ? preferred : defaultValue.columns[0]?.id;
      if (columnId) placements['default-board'] ??= { columnId, swimlaneKey: null, revision: 1 };
    }
    return placements;
  }
  if (defaultValue) {
    defaultValue.projectIds ??= projects.map(p => p.id);
    defaultValue.revision ??= 1;
    for (const t of state.tickets) {
      ensureTicket(t);
    }
  }
  const board = id => { const value = state.boards.find(b => b.id === id); if (!value) throw new Error('Board not found.'); return value; };
  const template = id => { const value = state.boardTemplates.find(b => b.id === id); if (!value) throw new Error('Board template not found.'); return value; };
  const normalizePlacement = (boardValue, placement) => {
    if (!placement || typeof placement !== 'object') throw new Error('Board placement is invalid.');
    safeId(placement.columnId, 'Column ID');
    if (!boardValue.columns.some(column => column.id === placement.columnId)) throw new Error('Column does not belong to this board.');
    const result = { columnId: placement.columnId, swimlaneKey: placement.swimlaneKey == null ? null : requiredText(placement.swimlaneKey, 'Swimlane key', 200), revision: (placement.revision ?? 0) + 1 };
    return result;
  };
  function assertColumnReferences(old, next) {
    const fieldChanged = old.grouping?.mode === 'field' && (next.grouping?.mode !== 'field' || next.grouping.field !== old.grouping.field);
    const changed = old.columns.filter(column => {
      const replacement = next.columns.find(value => value.id === column.id);
      return !replacement || fieldChanged || old.grouping?.mode === 'field' && (replacement.value ?? replacement.name) !== (column.value ?? column.name);
    });
    for (const column of changed) {
      if (workflowReferencesColumn(old.id, column.id)) throw new Error(`Column ${column.name} is referenced by a workflow and cannot be deleted.`);
      const used = Object.values(state.boardPlacements).some(placements => placements[old.id]?.columnId === column.id);
      if (used) throw new Error(`Column ${column.name} has ticket placements. Rehome those tickets before deleting it.`);
      if (old.grouping?.mode === 'field') {
        const field = old.grouping.field; const expected = column.value ?? column.name;
        const usedByField = state.tickets.some(ticketValue => {
          if (old.projectIds?.length && !old.projectIds.includes(ticketValue.projectId)) return false;
          const value = field.startsWith('custom.') ? ticketValue.customFields?.[field.slice(7)] : ticketValue[field];
          return String(value ?? '') === String(expected);
        });
        if (usedByField) throw new Error(`Column ${column.name} has field-backed tickets. Rehome those tickets before changing or deleting it.`);
      }
    }
  }
  function visibleTickets(boardValue) {
    return state.tickets.filter(t => isVisible(boardValue, t));
  }
  function isVisible(boardValue, original, override = {}) {
    const t = { ...original, ...override, customFields: override.customFields ?? original.customFields };
    const selectedProjects = new Set(boardValue.filters?.projectIds?.length ? boardValue.filters.projectIds : (boardValue.projectIds?.length ? boardValue.projectIds : projects.map(p => p.id)));
    {
      if (!selectedProjects.has(t.projectId)) return false;
      const f = boardValue.filters ?? {};
      if (f.statuses?.length && !f.statuses.includes(t.status)) return false;
      if (f.labels?.length && !f.labels.includes(t.label)) return false;
      if (f.agents?.length && !f.agents.includes(t.agent)) return false;
      if (f.priorities?.length && !f.priorities.includes(t.priority)) return false;
      if (f.query && !`${t.title} ${t.description ?? ''}`.toLowerCase().includes(f.query.toLowerCase())) return false;
      return true;
    }
  }
  function computedPlacement(b, t) {
    const stored = state.boardPlacements[String(t.id)]?.[b.id];
    if (b.grouping?.mode === 'field') {
      const field = b.grouping.field;
      const value = field.startsWith('custom.') ? t.customFields?.[field.slice(7)] : t[field];
      const column = b.columns.find(c => c.value === String(value ?? '')) ?? b.columns.find(c => c.id === String(value)) ?? b.columns[0];
      return { ...(stored ?? {}), columnId: column.id, source: 'field' };
    }
    return stored ?? { columnId: b.columns[0].id, swimlaneKey: null, revision: 1, source: 'local' };
  }
  function wipColumn(b, t) {
    // WIP must use exactly the placement projected to the board UI. In
    // particular, an unmapped field value falls back to the first column in a
    // field-backed board, just as computedPlacement() does.
    return computedPlacement(b, t).columnId;
  }
  function wipCounts(boardValue, tickets) {
    const counts = new Map();
    for (const value of tickets) {
      if (!isVisible(boardValue, value)) continue;
      const columnId = wipColumn(boardValue, value);
      counts.set(columnId, (counts.get(columnId) ?? 0) + 1);
    }
    return counts;
  }
  function validateProjectedWip(before, after) {
    // WIP is a projection of the complete board view, not a property of the
    // shared ticket. This covers local boards (including their implicit first
    // column) and field-backed boards uniformly.
    for (const b of state.boards) {
      const previous = wipCounts(b, before); const projected = wipCounts(b, after);
      for (const column of b.columns) {
        if (column.wipLimit === null) continue;
        const beforeCount = previous.get(column.id) ?? 0; const afterCount = projected.get(column.id) ?? 0;
        // Existing over-limit data is tolerated. Only an operation that adds
        // membership to a capped column (or otherwise increases its count)
        // is rejected.
        if (afterCount > column.wipLimit && afterCount > beforeCount) throw new Error(`Column ${column.name} is at its WIP limit.`);
      }
    }
  }
  function validateTicketUpdate(t, patch) {
    const projected = { ...t, ...patch, customFields: patch.customFields === undefined ? t.customFields : patch.customFields };
    const before = state.tickets; const after = state.tickets.map(value => value.id === t.id ? projected : value);
    validateProjectedWip(before, after);
  }
  function validateNewTicket(candidate) {
    validateProjectedWip(state.tickets, [...state.tickets, candidate]);
  }
  function validateTicketBatch(changes) {
    if (!Array.isArray(changes)) throw new Error('Ticket changes must be a list.');
    const projected = new Map(state.tickets.map(value => [value.id, value]));
    for (const change of changes) projected.set(change.next.id, change.next);
    validateProjectedWip(state.tickets, [...projected.values()]);
  }
  return {
    board, template, visibleTickets, computedPlacement, validateTicketUpdate, validateNewTicket, validateTicketBatch,
    validateColumnDeletion(boardId, columnId) {
      const b = board(boardId); const c = b.columns.find(value => value.id === columnId); if (!c) throw new Error('Column not found.');
      if (workflowReferencesColumn(boardId, columnId)) throw new Error(`Column ${c.name} is referenced by a workflow and cannot be deleted.`);
      if (Object.values(state.boardPlacements).some(placements => placements[boardId]?.columnId === columnId)) throw new Error(`Column ${c.name} has ticket placements. Rehome those tickets before deleting it.`);
      return true;
    },
    ensureTicket,
    async command(c) {
      if (c.action === 'saveBoard') {
        const old = c.id ? state.boards.find(value => value.id === c.id) : null;
        if (old && c.revision !== old.revision) throw new Error('Board changed in another client. Reload before saving.');
        const value = boardInput(c, projects, old); if (old) assertColumnReferences(old, value);
        if (old) Object.assign(old, value); else state.boards.push(value);
        await save(); return clone(value);
      }
      if (c.action === 'deleteBoard') {
        const old = board(c.id);
        if (c.revision !== old.revision) throw new Error('Board changed in another client. Reload before deleting.');
        if (workflowReferencesBoard(old.id)) throw new Error(`Board ${old.name} is referenced by a workflow and cannot be deleted.`);
        state.boards = state.boards.filter(value => value.id !== old.id); for (const placements of Object.values(state.boardPlacements)) delete placements[old.id]; await save(); return { id: old.id, deleted: true };
      }
      if (c.action === 'saveBoardTemplate') {
        const old = c.id ? state.boardTemplates.find(value => value.id === c.id) : null; if (old && c.revision !== old.revision) throw new Error('Board template changed in another client. Reload before saving.');
        const value = templateInput(c, old); if (old) Object.assign(old, value); else state.boardTemplates.push(value); await save(); return clone(value);
      }
      if (c.action === 'deleteBoardTemplate') {
        const old = template(c.id); if (c.revision !== old.revision) throw new Error('Board template changed in another client. Reload before deleting.');
        state.boardTemplates = state.boardTemplates.filter(value => value.id !== old.id); await save(); return { id: old.id, deleted: true };
      }
      if (c.action === 'createBoardFromTemplate') {
        const source = template(c.templateId); const value = boardInput({ ...source, ...c, id: c.id ?? randomUUID(), name: c.name ?? source.name, columns: c.columns ?? source.columns, swimlanes: c.swimlanes ?? source.swimlanes, filters: c.filters ?? source.filters, cardFields: c.cardFields ?? source.cardFields, grouping: c.grouping ?? source.grouping, density: c.density ?? source.density }, projects, null);
        state.boards.push(value); await save(); return clone(value);
      }
      if (c.action === 'setBoardPlacement') {
        const b = board(c.boardId); const t = ticket(c.ticketId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before placing it.');
        if (b.projectIds?.length && !b.projectIds.includes(t.projectId)) throw new Error('Ticket project is not available on this board.');
        const fromColumnId = computedPlacement(b, t).columnId;
        const normalized = normalizePlacement(b, c.placement); state.boardPlacements[String(t.id)] ??= {};
        const column = b.columns.find(value => value.id === normalized.columnId);
        const field = b.grouping?.mode === 'field' ? b.grouping.field : null;
        const fieldValue = field ? column.value ?? column.name : null;
        const previousFieldValue = field?.startsWith('custom.') ? t.customFields?.[field.slice(7)] : field ? t[field] : undefined;
        if (field === 'status' && (typeof fieldValue !== 'string' || !fieldValue.trim() || fieldValue.length > 80)) throw new Error('Shared status grouping needs a non-empty status value.');
        if (field === 'priority' && !['Low', 'Medium', 'High'].includes(fieldValue)) throw new Error('Shared priority grouping must use Low, Medium or High.');
        const projected = field?.startsWith('custom.')
          ? { customFields: { ...t.customFields, [field.slice(7)]: fieldValue } }
          : field ? { [field]: fieldValue } : {};
        const affectedBoards = field ? state.boards.filter(value => value.grouping?.mode === 'field' && value.grouping.field === field) : [b];
        for (const affected of affectedBoards) {
          const affectedColumn = affected === b ? column : affected.columns.find(value => (value.value ?? value.name) === fieldValue);
          if (!affectedColumn || affectedColumn.wipLimit === null || !isVisible(affected, t, projected)) continue;
          const visible = visibleTickets(affected).filter(value => value.id !== t.id);
          if (visible.filter(value => wipColumn(affected, value) === affectedColumn.id).length >= affectedColumn.wipLimit) throw new Error(`Column ${affectedColumn.name} is at its WIP limit.`);
        }
        // All checks above happen before either the board placement or shared field is changed.
        state.boardPlacements[String(t.id)][b.id] = normalized;
        if (field) {
          if (field.startsWith('custom.')) { t.customFields ??= {}; t.customFields[field.slice(7)] = fieldValue; }
          else if (field === 'status') t.status = fieldValue;
          else t[field] = fieldValue;
        }
        t.revision++; await save(); return {
          ticketId: t.id,
          boardId: b.id,
          placement: clone(normalized),
          fromColumnId,
          toColumnId: normalized.columnId,
          ticketFieldsChanged: field && previousFieldValue !== fieldValue
            ? [{ field, from: previousFieldValue ?? null, to: fieldValue }]
            : [],
          revision: t.revision,
        };
      }
      if (c.action === 'clearBoardPlacement') {
        const b = board(c.boardId); const t = ticket(c.ticketId); if (!t) throw new Error('Ticket not found.');
        if (c.revision !== t.revision) throw new Error('Ticket changed in another client. Reload before placing it.');
        const fromColumnId = computedPlacement(b, t).columnId;
        if (state.boardPlacements[String(t.id)]) delete state.boardPlacements[String(t.id)][b.id];
        const toColumnId = computedPlacement(b, t).columnId;
        t.revision++; await save(); return { ticketId: t.id, boardId: b.id, fromColumnId, toColumnId, revision: t.revision };
      }
      throw new Error('Unknown board command.');
    },
    snapshot() {
      return {
        boards: state.boards.map(b => ({ ...clone(b), tickets: visibleTickets(b).map(t => ({ ticketId: t.id, ...computedPlacement(b, t) })) })),
        boardTemplates: clone(state.boardTemplates),
      };
    },
  };
}

export { phaseColumn };
