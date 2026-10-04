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
  const externalThreads = {};
  const threadReads = [];
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
  const externalTickets = { listComments: async (_source, remoteId) => { threadReads.push(remoteId); return structuredClone(externalThreads[remoteId] ?? []); } };
  const catalog = createCatalog({ state, save: async () => { saved.push(structuredClone(state)); }, execution, externalTickets });
  return { state, catalog, saved, externalThreads, threadReads };
}

function addReplySource(fixture) {
  fixture.state.ticketConnections.push({ id: 'source-a', organizationId: 'personal', enabled: true, capabilities: { threadRead: true } });
  fixture.state.tickets[0].externalLinks = [{ connectionId: 'source-a', remoteId: 'remote-ticket' }];
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

test('workflow mutation receipts bind update and placement identity and deduplicate exact Work commands', async () => {
  const { catalog, state } = fixture();
  const update = { action: 'updateTicket', ticketId: 1, taskId: 1, revision: 1,
    patch: { status: 'Approved' }, workflowRunId: 'run-1', workflowInstance: 'step-1',
    idempotencyKey: 'run-1:step-1', requestId: 'step-1' };
  const updated = await catalog.command(update);
  const retried = await catalog.command(update);
  assert.deepEqual(retried, updated);
  assert.equal(state.workflowMutationReceipts['run-1:step-1:updateTicket'].result.status, 'Approved');
  assert.ok(catalog.workflowMutationReceipt(update));
  await assert.rejects(catalog.command({ ...update, patch: { status: 'Rejected' } }), /identity was reused/);

  const placement = { action: 'setBoardPlacement', boardId: 'default-board', ticketId: 1,
    revision: updated.revision, placement: { columnId: 'column-done' }, workflowRunId: 'run-1',
    workflowInstance: 'step-2', idempotencyKey: 'run-1:step-2' };
  const moved = await catalog.command(placement);
  assert.deepEqual(await catalog.command(placement), moved);
  assert.ok(catalog.workflowMutationReceipt(placement));
});

test('Work workflow evidence is project scoped, exact to its command, and retains the original mutation receipt', async () => {
  const { catalog, state } = fixture();
  const command = { action: 'createTicket', requestId: 'workflow-create-1', projectId: 'alpha',
    title: 'Prepared title', description: 'Prepared description', workflowRunId: 'run-a',
    workflowInstance: 'instance-a', idempotencyKey: 'run-a:instance-a' };
  const created = await catalog.command(command);
  const evidence = catalog.workflowActivityEvidence(command, 'alpha');
  assert.equal(evidence.result.id, created.id);
  assert.equal(evidence.result.title, 'Prepared title');
  assert.equal(evidence.ticket.projectId, 'alpha');
  assert.equal(catalog.workflowActivityEvidence(command, 'beta').ticket, null);
  assert.equal(catalog.workflowActivityEvidence({ ...command, title: 'Different request' }, 'alpha').result, null);

  const ticket = state.tickets.find(value => value.id === created.id);
  ticket.title = 'Later mutable title';
  ticket.revision += 1;
  const afterLaterEdit = catalog.workflowActivityEvidence(command, 'alpha');
  assert.equal(afterLaterEdit.result.title, 'Prepared title', 'the exact original Work receipt remains immutable');
  assert.equal(afterLaterEdit.ticket, null, 'a later ticket state is not substituted for the prepared result');
});

test('related-ticket evidence distinguishes an immutable receipt from a mutable request projection', async () => {
  const { catalog, state } = fixture();
  const command = { action: 'createRelatedTicket', sourceTicketId: 1, sourceRevision: 1,
    requestId: 'workflow-related-1', kind: 'related', title: 'Original related title',
    workflowRunId: 'run-a', workflowInstance: 'instance-a', idempotencyKey: 'run-a:instance-a' };
  const created = await catalog.command(command);
  const key = 'run-a:instance-a:createRelatedTicket';
  const beforeEdit = catalog.workflowActivityEvidence(command, 'alpha');
  assert.equal(beforeEdit.hasReceipt, true);
  assert.equal(beforeEdit.result.title, created.title);
  const target = state.tickets.find(value => value.id === created.id);
  target.title = 'Later title';
  target.revision += 1;
  assert.equal(catalog.workflowActivityEvidence(command, 'alpha').result.title, 'Original related title');
  delete state.workflowMutationReceipts[key];
  const noReceipt = catalog.workflowActivityEvidence(command, 'alpha');
  assert.equal(noReceipt.hasReceipt, false);
  assert.equal(noReceipt.result.title, 'Later title', 'legacy projection may be available but is not an exact typed receipt');
});

test('Work reply evidence checks exact identity and scopes latest delivered selection to its project and run', async () => {
  const f = fixture(); const { catalog, state } = f; addReplySource(f);
  state.ticketReplies = [
    { id: 'reply-alpha', ticketId: 1, connectionId: 'source-a', body: 'Exact body', status: 'queued', deliveryStatus: 'delivered',
      workflowRunId: 'run-a', workflowInstance: 'instance-a', remoteId: 'remote-a', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'reply-beta', ticketId: 2, connectionId: 'source-a', body: 'Foreign body', status: 'queued', deliveryStatus: 'delivered',
      workflowRunId: 'run-a', workflowInstance: 'instance-a', remoteId: 'remote-b', createdAt: '2026-09-02T00:00:00Z' },
  ];
  f.externalThreads['remote-ticket'] = [
    { remoteId: 'remote-a', body: 'Exact body', direction: 'outbound', deliveryStatus: 'delivered', authorRole: 'agent', createdAt: '2026-10-01T00:00:00Z' },
  ];
  state.ticketThreads = [{ id: 'source-a:1', ticketId: 1, connectionId: 'source-a', messages: structuredClone(f.externalThreads['remote-ticket']) }];
  const command = { action: 'postExternalTicketReply', requestId: 'reply-alpha', ticketId: 1,
    connectionId: 'source-a', body: 'Exact body', workflowRunId: 'run-a', workflowInstance: 'instance-a' };
  assert.equal(catalog.workflowActivityEvidence(command, 'alpha').reply.status, 'queued');
  assert.equal(catalog.workflowActivityEvidence({ ...command, body: 'Spoofed body' }, 'alpha').reply, null);
  assert.equal(catalog.workflowReplyConfirmation(command, 'alpha').state, 'completed');
  assert.equal(catalog.workflowReplyConfirmation(command, 'beta'), null);
  assert.equal((await catalog.latestDeliveredWorkflowReply({ ticketId: 1, connectionId: 'source-a', workflowRunId: 'run-a', projectId: 'alpha' })).requestId, 'reply-alpha');
  assert.equal(await catalog.latestDeliveredWorkflowReply({ ticketId: 2, connectionId: 'source-a', workflowRunId: 'run-a', projectId: 'alpha' }), null);
});

test('latest Work reply selection ignores a newer pending reply even if its local delivery flag is stale', async () => {
  const f = fixture(); const { catalog, state } = f; addReplySource(f);
  state.ticketReplies = [
    { id: 'reply-delivered', ticketId: 1, connectionId: 'source-a', body: 'Delivered body', status: 'queued',
      deliveryStatus: 'pending', workflowRunId: 'run-a', remoteId: 'remote-delivered', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'reply-newer', ticketId: 1, connectionId: 'source-a', body: 'Pending body', status: 'queued',
      deliveryStatus: 'delivered', workflowRunId: 'run-a', remoteId: 'remote-pending', createdAt: '2026-10-02T00:00:00Z' },
  ];
  f.externalThreads['remote-ticket'] = [
    { remoteId: 'remote-delivered', body: 'Delivered body', direction: 'outbound', deliveryStatus: 'delivered', authorRole: 'agent', createdAt: '2026-10-01T00:00:00Z' },
    { remoteId: 'remote-pending', body: 'Pending body', direction: 'outbound', deliveryStatus: 'queued', authorRole: 'agent', createdAt: '2026-10-02T00:00:00Z' },
  ];
  const selected = await catalog.latestDeliveredWorkflowReply({ ticketId: 1, connectionId: 'source-a', workflowRunId: 'run-a', projectId: 'alpha' });
  assert.equal(selected.requestId, 'reply-delivered');
});

test('Work reply selection accepts exact delivered thread evidence when its cached reply flag is pending', async () => {
  const f = fixture(); const { catalog, state } = f; addReplySource(f);
  state.ticketReplies = [{ id: 'reply-source-proof', ticketId: 1, connectionId: 'source-a', body: 'Exact delivered body',
    status: 'queued', deliveryStatus: 'pending', workflowRunId: 'run-a', remoteId: 'remote-exact', createdAt: '2026-10-01T00:00:00Z' }];
  f.externalThreads['remote-ticket'] = [
    { remoteId: 'remote-exact', body: 'Exact delivered body', direction: 'outbound', deliveryStatus: 'delivered', authorRole: 'agent', createdAt: '2026-10-01T00:00:00Z' },
  ];
  const selected = await catalog.latestDeliveredWorkflowReply({ ticketId: 1, connectionId: 'source-a', workflowRunId: 'run-a', projectId: 'alpha' });
  assert.equal(selected.requestId, 'reply-source-proof');
});

test('Work reply selection rejects a foreign-organization connection before reading its thread', async () => {
  const f = fixture(); addReplySource(f);
  f.state.ticketConnections[0].organizationId = 'foreign-org';
  await assert.rejects(f.catalog.latestDeliveredWorkflowReply({ ticketId: 1, connectionId: 'source-a',
    workflowRunId: 'run-a', projectId: 'alpha' }), /not available to this project/);
  assert.deepEqual(f.threadReads, []);
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
