import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { backupDeployment, restoreDeployment } from '../../scripts/convoy-backup.mjs';
import { createSqliteStore } from '../../apps/daemon/src/adapters/persistence/sqlite-store.mjs';

test('offline deployment backup restores state, identity, secrets, and attachment bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const backup = join(root, 'backup');
  const restored = join(root, 'restored');
  await mkdir(join(source, 'runtime', 'context-files'), { recursive: true });
  await mkdir(join(source, 'credentials'), { recursive: true });
  await writeFile(join(source, 'runtime', 'state.json'), '{"sessions":{}}');
  await writeFile(join(source, 'runtime', 'context-files', 'attachment'), 'image bytes');
  await writeFile(join(source, 'credentials', 'provider-secrets.key'), 'secret key');
  await writeFile(join(source, 'deployment.json'), '{"id":"test"}');
  const manifest = await backupDeployment(source, backup);
  assert.equal(manifest.files.length, 4);
  await restoreDeployment(backup, restored);
  assert.equal(await readFile(join(restored, 'runtime', 'state.json'), 'utf8'), '{"sessions":{}}');
  assert.equal(await readFile(join(restored, 'runtime', 'context-files', 'attachment'), 'utf8'), 'image bytes');
  assert.equal(await readFile(join(restored, 'credentials', 'provider-secrets.key'), 'utf8'), 'secret key');
  assert.equal(await readFile(join(restored, 'deployment.json'), 'utf8'), '{"id":"test"}');
  await assert.rejects(restoreDeployment(backup, restored), /already exists/);
  await writeFile(join(backup, 'data', 'runtime', 'state.json'), 'corrupted');
  await assert.rejects(restoreDeployment(backup, join(root, 'corrupt-restore')), /integrity check failed/);
});

test('backup refuses a live or stale daemon lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-backup-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'runtime'), { recursive: true });
  await writeFile(join(source, 'runtime', 'state.json'), '{}');
  await writeFile(join(source, 'daemon.lock'), String(process.pid));
  await assert.rejects(backupDeployment(source, join(root, 'live')), /Stop the Convoy daemon/);
  await writeFile(join(source, 'daemon.lock'), randomUUID());
  await assert.rejects(backupDeployment(source, join(root, 'stale')), /stale daemon.lock/);
});

test('offline backup restores a SQLite deployment with its state intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-sqlite-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'deployment');
  const directory = join(source, 'runtime');
  let store = await createSqliteStore(directory, { sessions: { chat: { id: 'chat', status: 'idle' } }, tickets: [] });
  store.data.sessions.chat.status = 'completed';
  await store.save();
  await store.close();
  await backupDeployment(source, join(root, 'backup'));
  await restoreDeployment(join(root, 'backup'), join(root, 'restored'));
  store = await createSqliteStore(join(root, 'restored', 'runtime'), {});
  assert.equal(store.data.sessions.chat.status, 'completed');
  await store.close();
});

test('PostgreSQL storage marker prevents a database-free backup of stale JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-postgres-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'deployment');
  await mkdir(join(source, 'runtime'), { recursive: true });
  await writeFile(join(source, 'runtime', 'state.json'), '{"old":"snapshot"}');
  await writeFile(join(source, 'runtime', 'storage.json'), JSON.stringify({ version: 1, backend: 'postgres', storeId: 'test' }));
  await assert.rejects(backupDeployment(source, join(root, 'incomplete')), /CONVOY_DATABASE_URL/);
});
