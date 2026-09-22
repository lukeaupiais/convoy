import assert from 'node:assert/strict';
import test from 'node:test';
import { createRowStore } from '../../apps/daemon/src/adapters/persistence/row-store.mjs';

test('persistence failure stops later writes and reports fatal loss once', async () => {
  let commits = 0;
  let failures = 0;
  const error = new Error('database unavailable');
  const store = await createRowStore({
    load: async () => [],
    commit: async () => { if (++commits > 1) throw error; },
    close: async () => {},
  }, { sessions: {} }, undefined, () => { failures++; });
  store.data.sessions.chat = { id: 'chat' };
  await assert.rejects(store.save(), /database unavailable/);
  await assert.rejects(store.save(), /database unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commits, 2);
  assert.equal(failures, 1);
});
