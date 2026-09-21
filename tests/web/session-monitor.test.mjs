import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/sessions/sessionMonitor.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sessionBucket, sessionReason, sessionStatus, liveModel } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const session = overrides => ({ status:'idle', events:[], pending:null, workspace:null, ...overrides });
test('session monitor excludes idle chats and normal replies from live attention', () => {
  assert.equal(sessionBucket(session({})), 'idle');
  assert.equal(sessionBucket(session({activeTicketId:1})), 'idle');
  assert.equal(sessionBucket(session({status:'awaiting_review',events:[{type:'assistant'}]})), 'history');
  assert.equal(sessionReason(session({status:'awaiting_review'})), 'Conversation turn completed.');
});
test('session monitor surfaces live execution and actionable holds, with or without tickets', () => {
  for (const status of ['running','queued','ready']) assert.equal(sessionBucket(session({status})), 'active');
  for (const status of ['waiting_question','waiting_approval','waiting_gate','failed','interrupted','awaiting_submission','awaiting_continue']) assert.equal(sessionBucket(session({status})), 'attention');
  assert.equal(sessionBucket(session({status:'paused'})), 'paused');
  assert.equal(sessionBucket(session({status:'awaiting_review',activeTicketId:1})), 'attention');
  assert.equal(sessionBucket(session({status:'accepted',assignment:{state:'uncertain'}})), 'attention');
  assert.equal(sessionBucket(session({status:'accepted',events:[{type:'workflow_completed'}]})), 'history');
});
test('Live counts actionable sessions and sessionless failures without counting paused work', () => {
  const state = {
    sessions: [
      { ...session({ id:'running', status:'running', projectId:'p', updatedAt:'2026-09-21T12:00:00Z' }) },
      { ...session({ id:'paused', status:'paused', projectId:'p', updatedAt:'2026-09-21T11:00:00Z' }) },
      { ...session({ id:'effect', status:'paused', projectId:'p', flow:{id:'flow',instance:'one'}, updatedAt:'2026-09-21T10:00:00Z' }) },
    ],
    tickets: [{id:42,projectId:'p'}],
    workflowEffects: [{effectKey:'flow:one:node',status:'uncertain',operation:'move_ticket'}, {effectKey:'missing:one:node',status:'uncertain',operation:'create_ticket'}],
    workflowTriggerFailures: [{triggerKey:'trigger',ticketId:42,workflowId:'flow',workflowVersion:1}],
    workflowTriggers: [{triggerKey:'trigger',status:'failed'}],
  };
  const model = liveModel(state);
  assert.deepEqual(model.attention.map(s => s.id), ['effect']);
  assert.deepEqual(model.active.map(s => s.id), ['running']);
  assert.deepEqual(model.paused.map(s => s.id), ['paused']);
  assert.equal(model.attentionCount, 3);
  assert.equal(sessionStatus(state.sessions[2], model.uncertainEffectFor(state.sessions[2])), 'Effect uncertain');
  assert.equal(liveModel(state, 'other').attentionCount, 0);
  state.workflowTriggers[0].status = 'started';
  assert.equal(liveModel(state).triggerFailures.length, 0);
});
