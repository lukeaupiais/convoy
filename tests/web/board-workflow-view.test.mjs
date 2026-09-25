import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/workflows/board-automation-view.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { relationshipSections, relationshipEvent } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const row = { kind: 'start_rule', scope: 'column', workflowId: 'review', workflowVersion: 3, workflowName: 'Copy review', columnId: 'ready', event: 'ticket_moved' };

test('groups workflow identities while preserving rules, actions and exact versions', () => {
  const relationships = [row, { ...row, ruleId: 'second' }, { ...row, workflowVersion: 2 },
    { ...row, kind: 'effect', nodeId: 'move' },
    { ...row, scope: 'project', columnId: undefined },
    { ...row, columnId: 'elsewhere', workflowId: 'other' }];
  const board = relationshipSections({ relationships });
  assert.equal(board.length, 3);
  assert.equal(board[0].rows.length, 4);
  assert.deepEqual(board[0].rows.map(value => value.workflowVersion), [3, 3, 2, 3]);
  assert.equal(board[1].project, true);
  const column = relationshipSections({ relationships }, 'ready');
  assert.equal(column.length, 1);
  assert.equal(column[0].rows.length, 4);
});

test('project and board rules never masquerade as column relationships', () => {
  const relationships = [
    { ...row, scope: 'project', columnId: undefined, event: 'ticket_imported' },
    { ...row, scope: 'project', columnId: undefined, event: 'ticket_message_received' },
    { ...row, scope: 'board', columnId: undefined },
  ];
  assert.deepEqual(relationshipSections({ relationships }, 'ready'), []);
  const board = relationshipSections({ relationships });
  assert.equal(board[0].rows.length, 2);
  assert.equal(board[0].project, true);
  assert.equal(board[1].project, false);
});

test('event and effect labels come from the authorized owner projection', () => {
  assert.equal(relationshipEvent({ ...row, label: 'Message received' }), 'Message received');
  assert.equal(relationshipEvent({ ...row, kind: 'effect', label: 'Sets Approved' }), 'Sets Approved');
});

test('unresolved effects remain separate from verified relationships', () => {
  const relationships = [row, { ...row, kind: 'effect', scope: 'board', columnId: undefined, unresolved: true }];
  const groups = relationshipSections({ relationships });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].unresolved, false);
  assert.equal(groups[1].unresolved, true);
  assert.equal(relationshipSections({ relationships }, 'ready').length, 1);
});
