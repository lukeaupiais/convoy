import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordModelUsage } from '../../apps/daemon/src/modules/conversations/index.mjs';

test('conversation usage accumulates reported tokens without inventing missing counts', () => {
  const session = {};
  assert.equal(recordModelUsage(session, undefined), false);
  assert.equal(recordModelUsage(session, { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0 }), true);
  assert.equal(recordModelUsage(session, { inputTokens: 1200, outputTokens: 30, cachedInputTokens: 900, cacheWriteTokens: 0 }), true);
  assert.deepEqual(session.modelUsage, {
    requests: 2,
    inputTokens: 2200,
    outputTokens: 50,
    cachedInputTokens: 900,
    cacheWriteTokens: 0,
  });
  assert.equal(recordModelUsage(session, { inputTokens: -1 }), false);
  assert.equal(session.modelUsage.requests, 2);
});

import { shouldCompactContext } from '../../apps/daemon/src/modules/conversations/index.mjs';

test('context uses last measured input including cache, not cumulative usage or character size', () => {
  const session = { id: 's', model: 'small-model', messages: [{ role: 'user', content: 'x'.repeat(300000) }] };
  const observation = { phase: 'generation', model: 'small-model', contextWindow: 272000, observedAt: 'now' };
  for (let i = 0; i < 30; i++) recordModelUsage(session, { inputTokens: 42670, cachedInputTokens: 40448 }, observation);
  assert.equal(session.contextUsage.inputTokens, 42670);
  assert.equal(session.contextUsage.compactAtTokens, 217600);
  assert.ok(session.modelUsage.inputTokens > 1000000);
  assert.equal(shouldCompactContext(session), false);
  recordModelUsage(session, { inputTokens: 217600, cachedInputTokens: 217600 }, observation);
  assert.equal(shouldCompactContext(session), true);
  const measured = structuredClone(session.contextUsage);
  recordModelUsage(session, { inputTokens: 100000, outputTokens: 300 }, { ...observation, phase: 'compaction' });
  assert.deepEqual(session.contextUsage, measured);
  session.model = 'other';
  assert.equal(shouldCompactContext(session), false);
  session.model = 'small-model';
  session.currentAgentSessionId = 'new-agent';
  assert.equal(shouldCompactContext(session), false);
});

test('unknown capacity, missing usage and a changed checkpoint do not reuse stale measurements', () => {
  const session = { id: 's', model: 'm', currentAgentSessionId: 'a', agentSessions: { a: {} } };
  const observation = { phase: 'generation', model: 'm', contextWindow: 10000, observedAt: 'now' };
  recordModelUsage(session, { inputTokens: 9000 }, observation);
  assert.equal(shouldCompactContext(session), true);
  session.agentSessions.a.checkpoint = { through: 3 };
  assert.equal(shouldCompactContext(session), false);
  recordModelUsage(session, { inputTokens: 9000 }, { ...observation, contextWindow: undefined });
  assert.equal(session.contextUsage.contextWindow, undefined);
  assert.equal(shouldCompactContext(session), false);
  recordModelUsage(session, { inputTokens: 9000 }, observation);
  recordModelUsage(session, { outputTokens: 10 }, observation);
  assert.equal(session.contextUsage, undefined);
  recordModelUsage(session, { inputTokens: 9000 }, observation);
  recordModelUsage(session, undefined, observation);
  assert.equal(session.contextUsage, undefined);
});
