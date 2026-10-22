import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../apps/web/src/features/board/board-moves.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { BoardMoves } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const ticket = { id: 7, revision: 2, status: 'Received', priority: 'Low', customFields: { phase: 'Draft' } };
const board = {
  id: 'editorial', grouping: { mode: 'local' },
  columns: [{ id: 'received', name: 'Received' }, { id: 'review', name: 'Review' }],
  tickets: [{ ticketId: 7, columnId: 'received' }],
};

test('a drop changes presentation before save completes and stale polls cannot undo it', () => {
  const moves = new BoardMoves();
  const pending = moves.start(board, ticket, 'review');
  assert.ok(pending);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'review');
  assert.equal(board.tickets[0].columnId, 'received', 'authoritative input is never mutated');
  assert.equal(moves.isBusy(7), true);
  assert.equal(moves.start(board, ticket, 'review'), undefined, 'a repeated drop on the same target must send nothing');
  moves.reconcile([ticket]);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'review');
  moves.accept(pending, 3);
  moves.reconcile([ticket]);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'review', 'a stale poll after acknowledgement cannot snap back');
  moves.reconcile([{ ...ticket, revision: 3 }]);
  assert.equal(moves.isBusy(7), false);
  const confirmed = { ...board, tickets: [{ ticketId: 7, columnId: 'review' }] };
  assert.equal(moves.project(confirmed, [ticket]).board, confirmed);
});

test('rejection rolls back to the latest authoritative placement, including concurrent changes', () => {
  const moves = new BoardMoves();
  const pending = moves.start(board, ticket, 'review');
  moves.reject(pending);
  const latest = { ...board, tickets: [{ ticketId: 7, columnId: 'elsewhere' }] };
  assert.equal(moves.project(latest, [ticket]).board.tickets[0].columnId, 'elsewhere');
  assert.equal(moves.isBusy(7), false);
});

test('a newer authoritative revision wins even when an automation moved the ticket elsewhere', () => {
  const moves = new BoardMoves();
  const pending = moves.start(board, ticket, 'review');
  moves.accept(pending, 3);
  moves.reconcile([{ ...ticket, revision: 4 }]);
  const latest = { ...board, tickets: [{ ticketId: 7, columnId: 'published' }] };
  assert.equal(moves.project(latest, [ticket]).board.tickets[0].columnId, 'published');
});

test('local moves preserve fields; status, priority and custom-field boards project their configured field', () => {
  for (const [field, value] of [['status', 'In review'], ['priority', 'High'], ['custom.phase', 'Approved']]) {
    const moves = new BoardMoves();
    const configured = { ...board, id: `unrelated-${field}`, grouping: { mode: 'field', field }, columns: [{ id: 'received', name: 'Intake' }, { id: 'review', name: 'Ready', value }] };
    moves.start(configured, ticket, 'review');
    const projected = moves.project(configured, [ticket]).tickets[0];
    assert.equal(field.startsWith('custom.') ? projected.customFields.phase : projected[field], value);
    assert.equal(ticket.customFields.phase, 'Draft');
    assert.equal(moves.project(board, [ticket]).board, board, 'another board never inherits this placement');
  }
  const moves = new BoardMoves();
  moves.start(board, ticket, 'review');
  assert.equal(moves.project(board, [ticket]).tickets[0], ticket);
});

test('no-op and invalid drops send nothing, and removed tickets release pending state', () => {
  const moves = new BoardMoves();
  assert.equal(moves.start(board, ticket, 'received'), undefined);
  assert.equal(moves.start(board, ticket, 'missing'), undefined);
  const pending = moves.start(board, ticket, 'review');
  moves.reconcile([]);
  assert.equal(moves.isBusy(7), false);
  const replacement = moves.start(board, ticket, 'review');
  moves.reject(pending);
  assert.equal(moves.isBusy(7), true, 'late completions cannot erase a different move');
  moves.reject(replacement);
});

test('an acknowledged move can be dragged straight back before the next poll using the saved revision', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  moves.accept(first, 3);
  assert.equal(moves.isBusy(7), false, 'server acknowledgement must unlock dragging without waiting for polling');
  const visible = moves.project(board, [ticket]);
  assert.equal(visible.tickets[0].revision, 3, 'the reverse move must use the acknowledged revision');
  const back = moves.start(visible.board, visible.tickets[0], 'received');
  assert.ok(back, 'dragging back should start another move immediately');
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'received');
  moves.reconcile([{ ...ticket, revision: 3 }]);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'received', 'the first move poll must not override the reverse move');
  moves.accept(back, 4);
  const returned = moves.project(board, [ticket]);
  assert.equal(returned.tickets[0].revision, 4);
  assert.ok(moves.start(returned.board, returned.tickets[0], 'review'), 'successive round trips remain draggable');
});

test('dragging back during an unresolved save updates immediately and serializes the reverse command', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  const view = moves.project(board, [ticket]);
  const back = moves.start(view.board, view.tickets[0], 'received');
  assert.ok(back, 'a pending save must not freeze dragging back');
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'received');
  assert.equal(moves.canSend(first), true);
  assert.equal(moves.canSend(back), false, 'reverse save waits for the first response');
  const next = moves.accept(first, 3);
  assert.equal(next, back);
  assert.equal(next.expectedRevision, 3);
  assert.equal(moves.canSend(back), true);
  moves.accept(back, 4);
  assert.equal(moves.isBusy(7), false);
});

test('a rejected reverse move restores the first confirmed placement before polling catches up', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  const visible = moves.project(board, [ticket]);
  const back = moves.start(visible.board, visible.tickets[0], 'received');
  moves.accept(first, 3);
  moves.reject(back);
  const restored = moves.project(board, [ticket]);
  assert.equal(restored.board.tickets[0].columnId, 'review');
  assert.equal(restored.tickets[0].revision, 3);
  assert.equal(moves.isBusy(7), false);
  moves.reconcile([{ ...ticket, revision: 4 }]);
  assert.equal(moves.project(board, [ticket]).board, board, 'a newer authoritative state still wins');
});

test('rejection or uncertain outcome cancels queued user moves without sending them', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  const visible = moves.project(board, [ticket]);
  const back = moves.start(visible.board, visible.tickets[0], 'received');
  moves.reject(first);
  assert.equal(moves.canSend(back), false);
  assert.equal(moves.isBusy(7), false);
  assert.equal(moves.project(board, [ticket]).board, board);
  assert.equal(moves.accept(first, 3), undefined, 'late responses cannot revive discarded moves');
});

test('rapid drags keep only the latest unsent target and skip redundant saves', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  let visible = moves.project(board, [ticket]);
  moves.start(visible.board, visible.tickets[0], 'received');
  visible = moves.project(board, [ticket]);
  moves.start(visible.board, visible.tickets[0], 'review');
  assert.equal(moves.accept(first, 3), undefined, 'the confirmed first move already matches the final target');
  assert.equal(moves.isBusy(7), false);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'review');
});

test('a snapshot arriving before the save reply does not leave a stale overlay or lock', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  moves.reconcile([{ ...ticket, revision: 4 }]);
  moves.accept(first, 3);
  assert.equal(moves.isBusy(7), false);
  assert.equal(moves.project(board, [ticket]).board, board);
});

test('disconnect cancels queued intent even if the connection recovers before the first save replies', () => {
  const moves = new BoardMoves();
  const first = moves.start(board, ticket, 'review');
  const visible = moves.project(board, [ticket]);
  const back = moves.start(visible.board, visible.tickets[0], 'received');
  assert.equal(moves.cancelQueued(), true);
  assert.equal(moves.accept(first, 3), undefined, 'reconnection must not silently dispatch old queued intent');
  assert.equal(moves.canSend(back), false);
  assert.equal(moves.project(board, [ticket]).board.tickets[0].columnId, 'review');
});
