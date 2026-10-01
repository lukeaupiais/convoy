import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/app/ticket-navigation.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ticketNavigationReducer } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('selecting any ticket opens its details even after an explicit execution view', () => {
  const execution = ticketNavigationReducer('details', { type: 'show', view: 'execution' });
  assert.equal(execution, 'execution');
  assert.equal(ticketNavigationReducer(execution, { type: 'ticket-selected' }), 'details');
});

test('explicit execution and terminal navigation remain available', () => {
  assert.equal(
    ticketNavigationReducer('details', { type: 'show', view: 'execution' }),
    'execution',
  );
  assert.equal(
    ticketNavigationReducer('execution', { type: 'show', view: 'terminal' }),
    'terminal',
  );
});
