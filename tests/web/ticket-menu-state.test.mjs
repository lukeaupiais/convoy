import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/tickets/ticket-menu-state.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ticketNeedsRecovery } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

const ticket = { id: 42 };
const session = (flow = {}) => ({ flow: { id: 'flow', instance: 'run-1', nodeId: 'review', ...flow } });

test('recovery is offered for blocked run states and uncertain assignments', () => {
  assert.equal(ticketNeedsRecovery({}, ticket, session({ status: 'paused' })), true);
  assert.equal(ticketNeedsRecovery({}, ticket, session({ status: 'failed' })), true);
  assert.equal(
    ticketNeedsRecovery({}, ticket, { ...session({ status: 'running' }), assignment: { state: 'uncertain' } }),
    true,
  );
});

test('recovery is offered only for the current activity effect or ticket automation failure', () => {
  const current = session({ status: 'running' });
  const key = 'flow:run-1:review';
  assert.equal(
    ticketNeedsRecovery({ workflowEffects: [{ effectKey: key, status: 'blocked' }] }, ticket, current),
    true,
  );
  assert.equal(
    ticketNeedsRecovery({ automationDecisions: [{ ticketId: '42', status: 'failed' }] }, ticket, current),
    true,
  );
  assert.equal(
    ticketNeedsRecovery({ workflowEffects: [{ effectKey: 'other:run:node', status: 'uncertain' }] }, ticket, current),
    false,
  );
});
