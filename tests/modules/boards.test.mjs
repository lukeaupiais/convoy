import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../../apps/daemon/src/modules/work/catalog.mjs';

const noExecution = () => ({
  legacyTicketSeeds: () => [],
  reservedTicketIds: () => [],
  migratedStatus: () => undefined,
  assertEditable: () => {},
  isBusy: () => false,
  syncTicket: () => {},
  projection: () => ({ workflow: null }),
});

function fixture() {
  const saved = [];
  const state = {
    projects: [
      { id: 'alpha', name: 'Alpha', description: '', revision: 1, placement: { mode: 'none' } },
      { id: 'beta', name: 'Beta', description: '', revision: 1, placement: { mode: 'none' } },
    ],
    tickets: [
      { id: 1, projectId: 'alpha', title: 'One', description: '', status: 'Backlog', label: 'Core', agent: 'Unassigned', priority: 'Medium', revision: 1 },
      { id: 2, projectId: 'beta', title: 'Two', description: '', status: 'Done', label: 'Core', agent: 'Unassigned', priority: 'Low', revision: 1 },
    ],
    sessions: {},
  };
  const execution = noExecution();
  const catalog = createCatalog({ state, save: async () => { saved.push(structuredClone(state)); }, execution });
  return { state, catalog, saved };
}

test('migration creates one editable multi-project board without changing tickets', () => {
  const { state, catalog } = fixture();
  assert.equal(state.boards.length, 1);
  assert.equal(state.boards[0].id, 'default-board');
  assert.deepEqual(state.tickets.map(t => [t.id, t.status]), [[1, 'Backlog'], [2, 'Done']]);
  const snapshot = catalog.snapshot();
  assert.deepEqual(snapshot.boards[0].tickets.map(t => [t.ticketId, t.columnId]), [[1, 'column-backlog'], [2, 'column-done']]);
  assert.deepEqual(snapshot.boards[0].projectIds, ['alpha', 'beta']);
  const again = createCatalog({ state, save: async () => {}, execution: noExecution() });
  assert.equal(state.boards.length, 1);
  assert.deepEqual(again.snapshot().boards[0].tickets.map(t => t.ticketId), [1, 2]);
});

test('boards can be created from editable templates and show multiple projects', async () => {
  const { catalog } = fixture();
  const template = await catalog.command({ action: 'saveBoardTemplate', name: 'Research', description: 'Editable', columns: [{ id: 'idea', name: 'Ideas', value: 'idea' }, { id: 'done', name: 'Done', value: 'done' }], grouping: { mode: 'field', field: 'custom.stage' } });
  const board = await catalog.command({ action: 'createBoardFromTemplate', templateId: template.id, name: 'Research alpha + beta', projectIds: ['alpha', 'beta'] });
  assert.equal(board.grouping.field, 'custom.stage');
  assert.deepEqual(board.projectIds, ['alpha', 'beta']);
  assert.equal(catalog.snapshot().boardTemplates.find(value => value.id === template.id).name, 'Research');
});

test('local placement changes one board only and enforces WIP before mutation', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Local', projectIds: ['alpha'], columns: [{ id: 'todo', name: 'Todo', wipLimit: 1 }, { id: 'done', name: 'Done' }] });
  const ticket = state.tickets[0];
  // Local boards implicitly place visible tickets in their first column.
  await assert.rejects(catalog.command({ action: 'createTicket', requestId: 'second', title: 'Second', projectId: 'alpha' }), /WIP limit/);
  assert.equal(ticket.revision, 1);
  assert.equal(catalog.snapshot().boards.find(b => b.id === 'default-board').tickets.find(t => t.ticketId === 1).columnId, 'column-backlog');
});

test('local WIP rejects an update that newly enters a filtered board, but permits unrelated over-limit edits', async () => {
  const { catalog, state } = fixture();
  const hidden = await catalog.command({ action: 'createTicket', requestId: 'hidden', title: 'Hidden', projectId: 'alpha', label: 'Other' });
  const board = await catalog.command({ action: 'saveBoard', name: 'Filtered local', projectIds: ['alpha'], filters: { labels: ['Core'] }, columns: [{ id: 'todo', name: 'Todo', wipLimit: 1 }, { id: 'done', name: 'Done' }] });
  await assert.rejects(catalog.command({ action: 'updateTicket', taskId: hidden.id, revision: hidden.revision, patch: { label: 'Core' } }), /WIP limit/);
  assert.equal(state.tickets.find(ticket => ticket.id === hidden.id).label, 'Other');
  // Simulate legacy over-limit data; a title-only edit does not increase the
  // projected column count and therefore remains allowed.
  const hiddenValue = state.tickets.find(ticket => ticket.id === hidden.id); hiddenValue.label = 'Core';
  state.boardPlacements[String(hidden.id)] ??= {};
  state.boardPlacements[String(hidden.id)][board.id] = { columnId: 'todo', revision: 1 };
  await catalog.command({ action: 'updateTicket', taskId: hidden.id, revision: hidden.revision, patch: { title: 'Hidden renamed' } });
  assert.equal(state.tickets.find(ticket => ticket.id === hidden.id).title, 'Hidden renamed');
});

test('field-backed placement updates the shared ticket field and custom fields', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Priority', projectIds: ['alpha'], columns: [{ id: 'medium', name: 'Medium', value: 'Medium' }, { id: 'high', name: 'High', value: 'High' }], grouping: { mode: 'field', field: 'priority' } });
  const priorityMove = await catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 1, placement: { columnId: 'high' } });
  assert.deepEqual(priorityMove.ticketFieldsChanged, [{ field: 'priority', from: 'Medium', to: 'High' }]);
  assert.equal(priorityMove.fromColumnId, 'medium');
  assert.equal(priorityMove.toColumnId, 'high');
  assert.equal(state.tickets[0].priority, 'High');
  const custom = await catalog.command({ action: 'saveBoard', name: 'Stage', projectIds: ['alpha'], columns: [{ id: 'queued', name: 'Queued', value: 'queued' }], grouping: { mode: 'field', field: 'custom.stage' } });
  const customMove = await catalog.command({ action: 'setBoardPlacement', boardId: custom.id, ticketId: 1, revision: 2, placement: { columnId: 'queued' } });
  assert.deepEqual(customMove.ticketFieldsChanged, [{ field: 'custom.stage', from: null, to: 'queued' }]);
  assert.equal(state.tickets[0].customFields.stage, 'queued');
});

test('local placement reports presentation movement without changing ticket fields', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Delivery', projectIds: ['alpha'], columns: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }] });
  const result = await catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 1, placement: { columnId: 'done' } });
  assert.equal(result.fromColumnId, 'todo');
  assert.equal(result.toColumnId, 'done');
  assert.deepEqual(result.ticketFieldsChanged, []);
  assert.equal(state.tickets[0].status, 'Backlog');
});

test('shared status grouping accepts user-defined status values', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Custom status', projectIds: ['alpha'], columns: [{ id: 'triage', name: 'Triage', value: 'Triage' }], grouping: { mode: 'field', field: 'status' } });
  await catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 1, placement: { columnId: 'triage' } });
  assert.equal(state.tickets[0].status, 'Triage');
  assert.equal(catalog.snapshot().boards.find(value => value.id === board.id).tickets[0].columnId, 'triage');
});

test('shared-field ticket updates enforce WIP before changing the ticket', async () => {
  const { catalog, state } = fixture();
  // Create the candidate before adding the constrained projection; the update
  // below is the membership-changing operation under test.
  const second = await catalog.command({ action: 'createTicket', requestId: 'third', title: 'Third', projectId: 'alpha' });
  const board = await catalog.command({ action: 'saveBoard', name: 'Status WIP', projectIds: ['alpha'], columns: [{ id: 'backlog', name: 'Backlog', value: 'Backlog' }, { id: 'triage', name: 'Triage', value: 'Triage', wipLimit: 1 }, { id: 'done', name: 'Done', value: 'Done' }], grouping: { mode: 'field', field: 'status' } });
  await catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 1, placement: { columnId: 'triage' } });
  await assert.rejects(catalog.command({ action: 'updateTicket', taskId: second.id, revision: second.revision, patch: { status: 'Triage' } }), /WIP limit/);
  assert.equal(state.tickets.find(t => t.id === second.id).status, 'Backlog');
});

test('field-board WIP counts an unmapped value in the displayed first column', async () => {
  const { catalog } = fixture();
  await catalog.command({ action: 'saveBoard', name: 'First-column WIP', projectIds: ['alpha'], columns: [{ id: 'first', name: 'First', wipLimit: 1 }, { id: 'later', name: 'Later' }], grouping: { mode: 'field', field: 'status' } });
  // Backlog is not a configured field value, but the board displays it in its
  // first column through computedPlacement's fallback.
  await assert.rejects(catalog.command({ action: 'createTicket', requestId: 'unknown-status', title: 'Unknown status', projectId: 'alpha', status: 'Backlog' }), /WIP limit/);
});

test('field-backed columns cannot be deleted or retargeted while tickets derive them', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Safe status', projectIds: ['alpha'], columns: [{ id: 'triage', name: 'Triage', value: 'Triage' }, { id: 'done', name: 'Done', value: 'Done' }], grouping: { mode: 'field', field: 'status' } });
  await catalog.command({ action: 'updateTicket', taskId: 1, revision: 1, patch: { status: 'Triage' } });
  const current = state.boards.find(value => value.id === board.id);
  await assert.rejects(catalog.command({ action: 'saveBoard', ...current, columns: [{ id: 'done', name: 'Done', value: 'Done' }] }), /field-backed tickets/);
  await assert.rejects(catalog.command({ action: 'saveBoard', ...current, columns: [{ id: 'triage', name: 'Renamed', value: 'Renamed' }, { id: 'done', name: 'Done', value: 'Done' }] }), /field-backed tickets/);
  await catalog.command({ action: 'saveBoard', ...current, columns: [{ id: 'triage', name: 'Renamed', value: 'Triage' }, { id: 'done', name: 'Done', value: 'Done' }] });
});

test('import WIP validation is atomic', async () => {
  const { catalog, state } = fixture();
  await catalog.command({ action: 'saveBoard', name: 'Import status', projectIds: ['alpha'], columns: [{ id: 'triage', name: 'Triage', value: 'Triage', wipLimit: 1 }, { id: 'done', name: 'Done', value: 'Done' }], grouping: { mode: 'field', field: 'status' } });
  const before = structuredClone(state.tickets);
  await assert.rejects(catalog.command({ action: 'importTickets', projectId: 'alpha', tickets: [{ id: 10, title: 'First', status: 'Triage' }, { id: 11, title: 'Second', status: 'Triage' }] }), /WIP limit/);
  assert.deepEqual(state.tickets, before);
});

test('column deletion protects ticket placements and workflow references', async () => {
  const referenced = fixture();
  const board = await referenced.catalog.command({ action: 'saveBoard', name: 'Protected', projectIds: ['alpha'], columns: [{ id: 'keep', name: 'Keep' }, { id: 'used', name: 'Used' }] });
  // The catalog's default checker is intentionally replaceable for runtime integration.
  assert.equal(referenced.catalog.boards.validateColumnDeletion(board.id, 'keep'), true);
  await referenced.catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 1, placement: { columnId: 'used' } });
  const revision = referenced.state.boards.find(b => b.id === board.id).revision;
  await assert.rejects(referenced.catalog.command({ action: 'saveBoard', id: board.id, revision, name: 'Protected', projectIds: ['alpha'], columns: [{ id: 'keep', name: 'Keep' }] }), /ticket placements/);
  const defaultRevision = referenced.state.boards.find(value => value.id === 'default-board').revision;
  await referenced.catalog.command({ action: 'deleteBoard', id: 'default-board', revision: defaultRevision });
  assert.equal(referenced.state.boards.some(value => value.id === 'default-board'), false);
  const restarted = createCatalog({ state: referenced.state, save: async () => {}, execution: noExecution() });
  assert.equal(restarted.snapshot().boards.some(value => value.id === 'default-board'), false);
});

test('board changes use optimistic ticket revisions and retain custom fields', async () => {
  const { catalog, state } = fixture();
  const board = await catalog.command({ action: 'saveBoard', name: 'Custom', projectIds: ['alpha'], columns: [{ id: 'a', name: 'A' }] });
  const value = await catalog.command({ action: 'updateTicket', taskId: 1, revision: 1, patch: { customFields: { owner: 'luke', estimate: 3 } } });
  assert.deepEqual(value.customFields, { owner: 'luke', estimate: 3 });
  const replaced = await catalog.command({ action: 'updateTicket', taskId: 1, revision: 2, patch: { customFields: { owner: 'maria' } } });
  assert.deepEqual(replaced.customFields, { owner: 'maria' });
  await assert.rejects(catalog.command({ action: 'setBoardPlacement', boardId: board.id, ticketId: 1, revision: 2, placement: { columnId: 'a' } }), /changed/);
  assert.equal(state.tickets[0].revision, 3);
});
