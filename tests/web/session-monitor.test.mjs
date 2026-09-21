import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/sessions/sessionMonitor.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { sessionBucket, sessionReason } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const session = overrides => ({ status:'idle', events:[], pending:null, workspace:null, ...overrides });
test('session monitor excludes idle chats and normal replies from live attention', () => {
  assert.equal(sessionBucket(session({})), 'idle');
  assert.equal(sessionBucket(session({activeTicketId:1})), 'idle');
  assert.equal(sessionBucket(session({status:'awaiting_review',events:[{type:'assistant'}]})), 'history');
  assert.equal(sessionReason(session({status:'awaiting_review'})), 'Conversation turn completed.');
});
test('session monitor surfaces live execution and actionable holds, with or without tickets', () => {
  for (const status of ['running','queued','ready']) assert.equal(sessionBucket(session({status})), 'active');
  for (const status of ['waiting_question','waiting_approval','waiting_gate','paused','failed','interrupted','awaiting_submission','awaiting_continue']) assert.equal(sessionBucket(session({status})), 'attention');
  assert.equal(sessionBucket(session({status:'awaiting_review',activeTicketId:1})), 'attention');
  assert.equal(sessionBucket(session({status:'accepted',assignment:{state:'uncertain'}})), 'attention');
  assert.equal(sessionBucket(session({status:'accepted',events:[{type:'workflow_completed'}]})), 'history');
});
