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

test('versioned library items persist under distinct organization and revision keys', async () => {
  const rows = new Map();
  const driver = {
    load: async () => [...rows.values()],
    commit: async (changed, removed) => {
      for (const row of removed) rows.delete(`${row.bucket}:${row.key}`);
      for (const row of changed) rows.set(`${row.bucket}:${row.key}`, row);
    },
    close: async () => {},
  };
  const fallback = { skills: [], capabilityProfiles: [], extensions: [] };
  const store = await createRowStore(driver, fallback);
  store.data.skills.push(
    { organizationId: 'personal', name: 'support', version: 1 },
    { organizationId: 'personal', name: 'support', version: 2 },
    { organizationId: 'other', name: 'support', version: 1 },
  );
  store.data.capabilityProfiles.push(
    { organizationId: 'personal', id: 'support', version: 1 },
    { organizationId: 'personal', id: 'support', version: 2 },
  );
  store.data.extensions.push(
    { organizationId: 'personal', id: 'support', revision: 'v1' },
    { organizationId: 'personal', id: 'support', revision: 'v2' },
  );
  await store.save();
  const reopened = await createRowStore(driver, fallback);
  assert.deepEqual(reopened.data, store.data);
});
