import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotQuery } from '../../apps/daemon/src/control-plane/snapshot-query.mjs';

test('overview loads the work catalog without session history; detail reads retain it', async () => {
  const history = 'session-history-only'.repeat(100_000);
  const session = { id: '1', projectId: 'publication', status: 'idle', events: [{ type: 'assistant', text: history }], commands: [{ output: history }] };
  const state = { sessions: { 1: session }, approvalRules: [], modelChecks: {} };
  const snapshot = createSnapshotQuery({
    state, getSession: () => session, jobs: new Map(),
    capabilities: {
      filterSessionPreview: () => ({ tools: [], skills: [] }),
      sessionSkillProjection: value => ({ events: value.events }),
    },
    moduleSnapshots: [{ snapshot: () => ({ tickets: [{ id: 1, title: 'Edition review', projectId: 'publication' }], boards: [{ id: 'editorial', projectIds: ['publication'], tickets: [{ ticketId: 1, columnId: 'received' }], columns: [], filters: {} }], projects: [] }) }],
    canMessage: () => true, auth: { status: async () => ({ connected: false }) }, models: [], provider: { id: 'fixture', capabilities: [] },
    accessScope: async () => ({ projectIds: ['publication'] }),
  });
  const overview = await snapshot(undefined, 'phone', {}, { view: 'overview' });
  assert.ok(JSON.stringify(overview).length < 10_000, 'board polling must not download accumulated session history');
  assert.equal(overview.sessionDetailsIncluded, false);
  assert.deepEqual(overview.sessions, []);
  assert.equal(overview.tickets[0].id, 1);
  assert.equal(overview.boards[0].tickets[0].ticketId, 1);
  const detail = await snapshot('1', 'phone', {});
  assert.equal(detail.sessions[0].events[0].text, history);
  assert.equal(detail.sessions[0].commands[0].output, history);
});

test('attention polling retains decision state without accumulated session payloads', async () => {
  const history = 'large private execution history'.repeat(100_000);
  const session = {
    id: 'chat-a', conversationId: 'chat-a', projectId: 'publication', title: 'Review',
    status: 'waiting_gate', updatedAt: '2026-10-16', activeTicketId: 1,
    events: [{ type: 'assistant', text: history }], commands: [{ output: history }],
    workflow: { steps: [{ name: history }] }, pastRuns: [{ history }],
    pending: { tool: 'shell', input: history }, pendingQuestion: { question: 'Proceed?', details: history },
    flow: { id: 'run-a', instance: 'one', status: 'waiting_gate', history: [{ output: history }] },
    assignment: { state: 'uncertain', details: history }, interruption: { needsReview: true, details: history },
    terminals: [{ state: 'running', output: history }], workspace: { path: history },
  };
  const snapshot = createSnapshotQuery({
    state: { sessions: { a: session, hidden: { ...session, id: 'hidden', projectId: 'other' } }, approvalRules: [], modelChecks: {} },
    getSession: () => session, jobs: new Map(),
    capabilities: {
      filterSessionPreview: () => { throw new Error('attention must not resolve execution capabilities'); },
      sessionSkillProjection: () => { throw new Error('attention must not project history'); },
    },
    moduleSnapshots: [], canMessage: () => true,
    auth: { status: async () => ({ connected: false }) }, models: [], provider: { id: 'fixture', capabilities: [] },
    accessScope: async () => ({ projectIds: ['publication'] }),
  });
  const attention = await snapshot(undefined, 'client', {}, { view: 'attention' });
  assert.ok(JSON.stringify(attention).length < 10_000, 'attention polling must stay independent of history size');
  assert.equal(attention.sessionDetailsIncluded, false);
  assert.equal(attention.sessions.length, 1, 'the same project authorization applies to summaries');
  const value = attention.sessions[0];
  assert.equal(value.id, session.id);
  assert.equal(value.conversationId, session.conversationId);
  assert.equal(value.pending.tool, 'shell');
  assert.equal(value.pendingQuestion.question, 'Proceed?');
  assert.equal(value.assignment.state, 'uncertain');
  assert.equal(value.interruption.needsReview, true);
  assert.deepEqual(value.flow, { id: 'run-a', instance: 'one', status: 'waiting_gate' });
  assert.deepEqual(value.events, []);
  assert.equal(value.commands, undefined);
});
