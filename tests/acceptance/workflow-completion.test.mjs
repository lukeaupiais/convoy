import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const reply = (text) => [{ type: 'text', text }];
const submit = (outcome = 'success') => [{ type: 'toolCall', id: 'submit', name: 'submit_step', arguments: { summary: 'Evidence reviewed', artifacts: [], outcome } }];
async function fixture(t, generate, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-completion-'));
  const requests = [];
  const runtime = await createRuntime({
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      requests.push(structuredClone(input.prompt));
      yield { type: 'result', message: { role: 'assistant', content: await generate(input, requests.length), stopReason: 'stop', timestamp: Date.now() } };
    },
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}) => runtime.command({ action, client: 'completion-test', ...input });
  const chat = await act('createConversation', { requestId: 'completion', projectId: 'agent-platform', placement: { mode: 'none' } });
  const command = (action, input = {}) => act(action, { sessionId: chat.sessionId, ...input });
  await command('claim');
  await act('saveWorkflow', { workflow: { id: 'review-record', name: 'Review record', nodes: [
    { id: 'assess', kind: 'agent', model: 'fixture', name: 'Assess', prompt: 'Assess evidence and submit.', maxRounds: 8, ...settings },
    { id: 'review', kind: 'human', name: 'Review', prompt: 'Review evidence.' },
  ], edges: [{ id: 'review', from: 'assess', to: 'review', outcome: 'success' }] } });
  await command('configure', { workflow: 'review-record' });
  await command('startWorkflow');
  const session = async () => (await runtime.snapshot(chat.sessionId)).sessions[0];
  const until = async (predicate) => {
    for (let i = 0; i < 400; i++) {
      const value = await session();
      if (predicate(value)) return value;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Completion workflow did not settle');
  };
  return { requests, command, session, until, done: () => until(s => !s.control.busy && s.status !== 'running' && s.status !== 'ready') };
}

test('premature stop gets durable feedback in the same session; accepted submission ends correction', async t => {
  const f = await fixture(t, async (input, n) => {
    if (n === 1) return reply('Next internal action: finish the investigation.');
    assert.match(JSON.stringify(input.prompt.messages), /no submit_step has been accepted/);
    assert.match(JSON.stringify(input.prompt.messages), /Next internal action/);
    return submit();
  });
  const s = await f.done();
  assert.equal(s.status, 'waiting_gate', JSON.stringify(s.events.slice(-5)));
  assert.equal(f.requests.length, 2);
  assert.equal(s.events.filter(e => e.type === 'completion_continued').length, 1);
  assert.deepEqual(s.events.filter(e => e.type === 'model_request_settings').map(e => e.budget.round), [0, 1]);
  assert.equal(new Set(s.events.filter(e => e.type === 'model_request_settings').map(e => e.agentSessionId)).size, 1);
});

test('repeated ordinary stops reach a bounded incomplete result without advancing', async t => {
  const f = await fixture(t, () => reply('Will investigate later.'));
  const s = await f.done();
  assert.equal(s.status, 'awaiting_submission');
  assert.equal(s.flow.nodeId, 'assess');
  assert.equal(f.requests.length, 3);
  assert.equal(s.events.findLast(e => e.type === 'submission_required').reason, 'completion_correction_limit');
});

test('corrections consume the original budget and finalization ends honestly', async t => {
  const f = await fixture(t, () => reply('Not enough evidence.'), { maxRounds: 2, finalizationRounds: 1 });
  const s = await f.done();
  assert.equal(s.status, 'awaiting_submission');
  assert.equal(f.requests.length, 2);
  assert.equal(s.events.findLast(e => e.type === 'submission_required').reason, 'budget_exhausted');
});

test('rejected submission is not completion and may be corrected', async t => {
  const f = await fixture(t, (input, n) => {
    if (n === 1) return submit('nonexistent');
    if (n === 2) return reply('I will correct the submission.');
    assert.match(JSON.stringify(input.prompt.messages), /error/);
    return submit();
  });
  const s = await f.done();
  assert.equal(s.status, 'waiting_gate');
  assert.equal(f.requests.length, 3);
  assert.equal(s.events.filter(e => e.type === 'completion_continued').length, 1);
});

test('a pending question waits; cancellation cannot trigger corrective continuation', async t => {
  const f = await fixture(t, () => [{ type: 'toolCall', id: 'question', name: 'ask_user', arguments: { question: 'Which record should be assessed?' } }]);
  await f.until(s => !!s.pendingQuestion);
  assert.equal(f.requests.length, 1);
  await f.command('cancelWorkflow');
  const s = await f.done();
  assert.equal(s.flow.status, 'cancelled');
  assert.equal(f.requests.length, 1);
  assert.equal(s.events.filter(e => e.type === 'completion_continued').length, 0);
});

test('submission schema and actionable feedback allow malformed outcome recovery', async t => {
  const f = await fixture(t, (input, n) => {
    const tool = input.tools.find(tool => tool.name === 'submit_step');
    assert.deepEqual(tool.parameters.properties.outcome.enum, ['success']);
    if (n === 1) return submit('I recommend accepting this work');
    const feedback = JSON.stringify(input.prompt.messages);
    assert.match(feedback, /invalid_outcome/);
    assert.match(feedback, /allowed/);
    return submit('success');
  });
  const s = await f.done();
  assert.equal(s.status, 'waiting_gate');
  assert.equal(f.requests.length, 2);
  assert.equal(s.events.filter(e => e.type === 'step_submitted').length, 1);
});

const unfinished = reason => [{type: 'toolCall', id: 'incomplete', name: 'finish_incomplete', arguments: {
  reason, summary: 'Observed a partial result', missingEvidence: 'The reload check remains unperformed', nextAction: 'Reopen the synthetic record and verify persisted state',
}}];
test('incomplete exit preserves the unfinished step and rejects later calls in the same response', async t => {
  const f = await fixture(t, (input, n) => {
    if (n === 1) return unfinished('budget'); // Must not stop while exploration remains.
    assert.match(JSON.stringify(input.prompt.messages), /Investigation requests remain/);
    return [...unfinished('budget'), ...submit()];
  }, {maxRounds: 3, finalizationRounds: 2});
  const s = await f.done();
  assert.equal(s.status, 'awaiting_submission');
  assert.equal(s.flow.nodeId, 'assess');
  assert.equal(f.requests.length, 2);
  assert.equal(s.events.filter(e => e.type === 'workflow_incomplete').length, 1);
  assert.equal(s.events.filter(e => ['step_submitted','verification_sealed','step_completed'].includes(e.type)).length, 0);
  assert.equal(s.events.findLast(e => e.type === 'tool_result' && e.tool === 'submit_step').isError, true);
});
test('observed blocker can end incomplete and explicit continuation resumes the same step', async t => {
  const f = await fixture(t, (_input, n) => n === 1 ? unfinished('blocked') : submit());
  let s = await f.done();
  assert.equal(s.status, 'awaiting_submission');
  assert.equal(s.flow.nodeId, 'assess');
  await f.command('continueWorkflow', {instance: s.flow.instance});
  s = await f.done();
  assert.equal(s.status, 'waiting_gate');
  assert.equal(f.requests.length, 2);
});
