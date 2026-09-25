import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createSqliteStore } from '../../apps/daemon/src/adapters/persistence/sqlite-store.mjs';
import { createCapabilities } from '../../apps/daemon/src/modules/library/index.mjs';

test('SQLite preserves Library identities across publications, tenants, and restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-library-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = await createSqliteStore(directory, { sessions: {}, projects: [], runners: [] });
  const library = createCapabilities({ state: store.data });
  for (const organizationId of ['personal', 'another-org']) {
    for (const version of [1, 2]) {
      library.command({ action: 'publishSkill', organizationId, trusted: true,
        baseVersion: version - 1, files: { 'SKILL.md': `---\nname: document-review\ndescription: Review documents.\n---\nProcedure ${version}` } });
      library.command({ action: 'publishExtension', organizationId, trusted: true, client: 'persistence-test',
        manifest: { id: 'review-mcp', kind: 'mcp', revision: `revision-${version}`,
          execution: { location: 'runner', adapter: 'mcp-stdio' }, tools: [{
            id: 'review.read', name: 'review_read', description: 'Read a document.',
            approval: 'ask', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          }] } });
      library.command({ action: 'publishProfile', organizationId, id: 'review', name: 'Review',
        baseVersion: version - 1, tools: [], skills: [{ name: 'document-review', version }] });
    }
  }
  store.data.disabledTools = ['convoy.read_file'];
  const expected = structuredClone(store.data);
  await store.save();
  await store.close();
  store = await createSqliteStore(directory, {});
  assert.deepEqual(store.data, expected);
  await store.save();
  await store.close();
});

test('SQLite replaces legacy skill row keys without changing their payloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-skill-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { skills: [1, 2].map(version => ({
    name: 'document-review', organizationId: 'personal', version, body: `Procedure ${version}`,
  })) };
  let store = await createSqliteStore(directory, state);
  await store.close();
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  for (const row of db.prepare("SELECT item_key, payload FROM state_items WHERE bucket='skills'").all()) {
    const skill = JSON.parse(row.payload);
    db.prepare("UPDATE state_items SET item_key=? WHERE bucket='skills' AND item_key=?")
      .run(`personal:${skill.name}@${skill.version}`, row.item_key);
  }
  db.close();
  store = await createSqliteStore(directory, {});
  await store.save();
  await store.close();
  store = await createSqliteStore(directory, {});
  assert.deepEqual(store.data, state);
  await store.close();
});

test('SQLite still rejects duplicate skill revision identities', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-skill-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skill = { name: 'document-review', organizationId: 'personal', version: 1 };
  await assert.rejects(createSqliteStore(directory, { skills: [skill, { ...skill }] }), /unique item IDs/);
});

test('SQLite imports existing state once and preserves conversation data across restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    persistenceBackend: 'sqlite',
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {},
  };
  const legacy = await createRuntime({ ...options, persistenceBackend: 'file' });
  const prior = await legacy.command({ action: 'createConversation', requestId: 'legacy-create', client: 'sqlite-client' });
  await legacy.close();
  const original = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  let runtime = await createRuntime(options);
  assert.ok((await runtime.snapshot()).conversations.some((value) => value.id === prior.id));
  const created = await runtime.command({ action: 'createConversation', requestId: 'sqlite-create', client: 'sqlite-client' });
  await runtime.close();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')), original);
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  assert.ok(db.prepare("SELECT count(*) AS total FROM state_items WHERE bucket='conversations'").get().total >= 2);
  db.close();
  runtime = await createRuntime(options);
  assert.ok((await runtime.snapshot()).conversations.some((value) => value.id === created.id));
  await runtime.close();
});

test('SQLite refuses an existing empty or unreadable database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createSqliteStore(directory, { sessions: {}, tickets: [] });
  await store.close();
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  db.exec('DELETE FROM state_items');
  db.close();
  await assert.rejects(createSqliteStore(directory, {}), /empty/);
});

test('SQLite preserves multiple published workflow revisions with the same workflow ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-revisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { sessions: {}, workflows: [
    { id: 'delivery', version: 1, nodes: [{ id: 'one' }] },
    { id: 'delivery', version: 2, nodes: [{ id: 'two' }] },
  ] };
  let store = await createSqliteStore(directory, state);
  await store.close();
  store = await createSqliteStore(directory, {});
  assert.deepEqual(store.data.workflows, state.workflows);
  await store.close();
});

test('deployment storage identity refuses a missing SQLite database after first start', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    persistenceBackend: 'sqlite',
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {},
  };
  const runtime = await createRuntime(options);
  await runtime.close();
  await assert.rejects(createRuntime({ ...options, persistenceBackend: 'file' }), /Database-backed state exists/);
  await unlink(join(directory, 'state.sqlite'));
  await assert.rejects(createRuntime(options), /database is missing/);
});
