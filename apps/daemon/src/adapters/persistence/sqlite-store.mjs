import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRowStore } from './row-store.mjs';

export async function createSqliteStore(directory, fallback, storeId, existingMarker = false, onFatal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.sqlite');
  let newDatabase = false;
  try { await stat(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    newDatabase = true;
  }
  if (storeId && newDatabase && existingMarker)
    throw new Error('SQLite database is missing for this deployment storage identity.');
  if (storeId && !newDatabase && !existingMarker)
    throw new Error('SQLite database exists without a deployment storage identity.');
  let legacyState;
  if (newDatabase) {
    try { legacyState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Legacy runtime state is unreadable. Refusing to migrate it.');
    }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1 || (!newDatabase && version !== 1))
      throw new Error('Unsupported SQLite runtime schema version.');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      throw new Error('SQLite runtime state failed its integrity check.');
    db.exec(`CREATE TABLE IF NOT EXISTS state_items (
      bucket TEXT NOT NULL, item_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY (bucket, item_key)
    ) STRICT;`);
    db.exec('CREATE TABLE IF NOT EXISTS store_identity (id TEXT NOT NULL) STRICT;');
    if (newDatabase && storeId)
      db.prepare('INSERT INTO store_identity (id) VALUES (?)').run(storeId);
    if (storeId) {
      const identities = db.prepare('SELECT id FROM store_identity').all();
      if (identities.length !== 1 || identities[0].id !== storeId)
        throw new Error('SQLite database does not match this deployment storage identity.');
    }
    if (newDatabase) db.exec('PRAGMA user_version=1');
    const select = db.prepare('SELECT bucket, item_key, ordinal, payload FROM state_items');
    if (!newDatabase && select.all().length === 0)
      throw new Error('SQLite runtime state is empty. Refusing to replace it.');
    const upsert = db.prepare(`INSERT INTO state_items (bucket,item_key,ordinal,payload) VALUES (?,?,?,?)
      ON CONFLICT(bucket,item_key) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload`);
    const remove = db.prepare('DELETE FROM state_items WHERE bucket=? AND item_key=?');
    const store = await createRowStore({
      load: async () => select.all().map((row) => ({ bucket: row.bucket, key: row.item_key, position: row.ordinal, payload: row.payload })),
      commit: async (changed, removed) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of removed) remove.run(row.bucket, row.key);
          for (const row of changed) upsert.run(row.bucket, row.key, row.position, row.payload);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      close: async () => db.close(),
    }, fallback, legacyState, onFatal);
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}
