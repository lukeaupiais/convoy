import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotQuery } from '../../apps/daemon/src/control-plane/snapshot-query.mjs';

test('overview loads the work catalog without session history; detail reads retain it', async () => {
  const history = 'session-history-only'.repeat(100_000);
  const session = { id: '1', projectId: 'publication', status: 'idle', events: [{ type: 'assistant', text: history }], commands: [{ output: history }] };
  const state = { sessions: { 1: session }, approvalRules: [], modelChecks: {} };
  const snapshot = createSnapshotQuery({
    state, getSession: () => session, jobs: new Map(),
    capabilities: { preview: () => ({ tools: [], skills: [] }) },
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
