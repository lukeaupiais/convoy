import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

test('PostgreSQL persists sessions and excludes a second coordinator', {
  skip: !process.env.CONVOY_TEST_DATABASE_URL,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-postgres-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    persistenceBackend: 'postgres',
    databaseUrl: process.env.CONVOY_TEST_DATABASE_URL,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {},
  };
  let runtime = await createRuntime(options);
  try {
    const created = await runtime.command({ action: 'createConversation', requestId: 'postgres-session', client: 'postgres-client' });
    await assert.rejects(createRuntime(options), /Another Convoy coordinator/);
    await runtime.close();
    runtime = null;
    runtime = await createRuntime(options);
    assert.ok((await runtime.snapshot()).conversations.some((value) => value.id === created.id));
  } finally { await runtime?.close(); }
});
