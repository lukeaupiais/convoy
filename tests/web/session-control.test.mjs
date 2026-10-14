import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/from 'react'/g, `from '${import.meta.resolve('react')}'`)
  .replace(/import \{ newId \} from '[^']+';/, "const newId = () => 'browser-client';");
const { command } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
function fixture(t, { independent = true, owned = false, conflict = false, stale = false } = {}) {
  const calls = []; let runOwned = owned;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = options?.body && JSON.parse(options.body);
    if (!body) { calls.push('read-session'); return Response.json({ sessions: [{ id: 'chat-study', workflowRunId: 'study-run' }] }); }
    calls.push(body.action);
    if (body.action === 'getWorkflowRun') return Response.json({ result: { id: 'study-run', sessionId: 'chat-study', independent, lease: runOwned ? { ownedByCurrentCaller: true, expiresAt: stale ? 0 : Date.now() + 90000 } : null } });
    if (body.action === 'claimWorkflowRun') {
      if (conflict) return Response.json({ error: 'Workflow run is controlled by another client.' }, { status: 400 });
      runOwned = true;
    }
    if (body.action === 'claim' && independent && !runOwned) return Response.json({ error: 'Claim workflow run control first.' }, { status: 400 });
    return Response.json({ result: {} });
  });
  return calls;
}
test('claiming a linked independent session acquires its run before its session', async t => {
  const calls = fixture(t); await command('claim', { sessionId: 'chat-study', label: 'Ticket workflow' });
  assert.deepEqual(calls, ['read-session', 'getWorkflowRun', 'claimWorkflowRun', 'claim']);
});
test('legacy sessions do not claim independent-run control', async t => {
  const calls = fixture(t, { independent: false }); await command('claim', { sessionId: 'chat-study' });
  assert.equal(calls.includes('claimWorkflowRun'), false);
});
test('existing owned run control remains stable for prepared approval evidence', async t => {
  const calls = fixture(t, { owned: true }); await command('claim', { sessionId: 'chat-study' });
  assert.equal(calls.includes('claimWorkflowRun'), false);
});
test('conflicting run control prevents session acquisition and preserves the error', async t => {
  const calls = fixture(t, { conflict: true }); await assert.rejects(command('claim', { sessionId: 'chat-study' }), /another client/);
  assert.equal(calls.includes('claim'), false);
});
test('expired run ownership is renewed before claiming the session', async t => {
  const calls = fixture(t, { owned: true, stale: true }); await command('claim', { sessionId: 'chat-study' });
  assert.equal(calls.includes('claimWorkflowRun'), true);
});
