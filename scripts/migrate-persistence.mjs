import assert from 'node:assert/strict';
import { open, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupDeployment } from './convoy-backup.mjs';
import { createSqliteStore } from '../apps/daemon/src/adapters/persistence/sqlite-store.mjs';
import { createPostgresStore } from '../apps/daemon/src/adapters/persistence/postgres-store.mjs';

/** Promote one stopped SQLite deployment into a dedicated PostgreSQL database. */
export async function migrateToPostgres(dataDirectory, backupDirectory, connectionString) {
  if (!connectionString) throw new Error('CONVOY_DATABASE_URL is required.');
  const root = resolve(dataDirectory);
  const runtime = join(root, 'runtime');
  const markerPath = join(runtime, 'storage.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.version !== 1 || marker.backend !== 'sqlite' || !marker.storeId)
    throw new Error('Migration requires a SQLite deployment with a valid storage identity.');
  await backupDeployment(root, backupDirectory);
  const source = await createSqliteStore(runtime, {}, marker.storeId, true);
  let state;
  try { state = structuredClone(source.data); } finally { await source.close(); }
  const target = await createPostgresStore(runtime, {}, connectionString, false, marker.storeId,
    false, () => {}, state, true);
  await target.close();
  const verified = await createPostgresStore(runtime, {}, connectionString, false, marker.storeId,
    false, () => {}, undefined, true);
  try { assert.deepStrictEqual(verified.data, state); }
  finally { await verified.close(); }
  const next = `${markerPath}.tmp-${process.pid}`;
  const file = await open(next, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ ...marker, backend: 'postgres' }));
    await file.sync();
  } finally { await file.close(); }
  await rename(next, markerPath);
  const directory = await open(runtime, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { backupDirectory: resolve(backupDirectory), storeId: marker.storeId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, backup] = process.argv.slice(2);
  if (!source || !backup) {
    console.error('Usage: CONVOY_DATABASE_URL=postgres://... npm run migrate:postgres -- DATA_DIRECTORY NEW_BACKUP_DIRECTORY');
    process.exitCode = 2;
  } else {
    try {
      const result = await migrateToPostgres(source, backup, process.env.CONVOY_DATABASE_URL);
      console.log(`Migration complete. Offline backup: ${result.backupDirectory}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
