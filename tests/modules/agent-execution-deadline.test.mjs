import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentExecution } from '../../apps/daemon/src/control-plane/agent-execution.mjs';
import { normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/index.mjs';

function fixture(t, node = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const session = { id: 'research', messages: [], flow: { nodeId: 'investigate', status: 'running' },
    workflow: { nodes: [{ id: 'investigate', kind: 'agent', model: 'fixture', ...node }] } };
  let handlers;
  const execution = createAgentExecution({
    sessionExecution: {}, capabilities: { pinDefault() {} }, store: { save: async () => {} },
    providerGateway: { describeModel: async () => ({}) }, providerContext: async () => ({}),
    runners: { runAgent: async (_runner, _options, value, signal) => {
      handlers = value;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    steering: { settle() {}, hold() {}, interrupt(s, reason, needsReview) { s.interruption = { reason, needsReview }; } },
    event: (_s, type, data) => events.push({ type, ...data }),
    getEngine: () => ({ fail: async () => {} }),
  });
  const done = execution.run(session, 'Investigate', controller, 'activity');
  return { session, controller, events, done, disconnect: () => handlers.disconnected() };
}

test('healthy agent work continues past fifteen minutes and reports its actual default deadline', async t => {
  const f = fixture(t);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15 * 60_000);
  assert.equal(f.controller.signal.aborted, false);
  t.mock.timers.tick(45 * 60_000);
  await f.done;
  assert.match(f.session.interruption.reason, /time limit.*60 minutes/i);
  assert.match(f.events.at(-1).message, /time limit.*60 minutes/i);
});

test('a pinned agent deadline expires explicitly without looking like a user stop', async t => {
  const f = fixture(t, { executionTimeoutSeconds: 90 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(90_000);
  assert.equal(f.controller.signal.aborted, true);
  await f.done;
  assert.match(f.events.at(-1).message, /time limit.*90 seconds/i);
  assert.doesNotMatch(f.session.interruption.reason, /Turn stopped/);
});

test('a lost runner reports disconnect rather than a timeout or user stop', async t => {
  const f = fixture(t);
  await new Promise(resolve => setImmediate(resolve));
  f.disconnect();
  await f.done;
  assert.match(f.session.interruption.reason, /runner.*disconnect/i);
});

test('an explicit stop keeps its existing stop behavior', async t => {
  const f = fixture(t);
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  await f.done;
  assert.match(f.session.interruption.reason, /^Turn stopped/);
});

test('workflow publication validates and preserves a bounded explicit agent deadline', () => {
  const workflow = executionTimeoutSeconds => ({ id: 'research', name: 'Research', nodes: [
    { id: 'investigate', name: 'Investigate', kind: 'agent', executionTimeoutSeconds },
  ], edges: [] });
  assert.equal(normalizeWorkflow(workflow(7200)).nodes[0].executionTimeoutSeconds, 7200);
  for (const value of [0, -1, 1.5, 43201, '90'])
    assert.throws(() => normalizeWorkflow(workflow(value)), /execution timeout/i);
});
