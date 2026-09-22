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
