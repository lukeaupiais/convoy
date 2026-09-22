import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createRowStore } from './row-store.mjs';

/** A deployment owns one PostgreSQL database and one coordinator writer. */
export async function createPostgresStore(directory, fallback, connectionString, importLegacy = false, storeId, existingMarker = false, onFatal = () => {}, seedState, migrationMode = false) {
  if (typeof connectionString !== 'string' || !connectionString)
    throw new Error('CONVOY_DATABASE_URL is required for PostgreSQL persistence.');
  const client = new pg.Client({ connectionString });
  let closing = false;
  let failed = false;
  const fatal = (error) => {
    if (!closing && !failed) {
      failed = true;
      void Promise.resolve().then(() => onFatal(error)).catch(() => {});
    }
  };
  client.on('error', fatal);
  client.on('end', () => fatal(new Error('PostgreSQL coordinator connection ended.')));
  await client.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(112407421) AS acquired');
    if (!lock.rows[0]?.acquired)
      throw new Error('Another Convoy coordinator owns this PostgreSQL deployment.');
    const existing = await client.query("SELECT to_regclass('public.convoy_state_items') AS table_name");
    if (storeId && existingMarker && !existing.rows[0].table_name && !migrationMode)
      throw new Error('PostgreSQL state is missing for this deployment storage identity.');
    if (storeId && !existingMarker && existing.rows[0].table_name && !migrationMode)
      throw new Error('PostgreSQL state exists without a deployment storage identity.');
    if (!existing.rows[0].table_name) {
      const tables = await client.query("SELECT count(*)::integer AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
      if (tables.rows[0].total)
        throw new Error('PostgreSQL persistence requires a dedicated empty database.');
    }
    const schemaInfo = await client.query("SELECT to_regclass('public.convoy_schema_info') AS table_name");
    const storageIdentity = await client.query("SELECT to_regclass('public.convoy_storage_identity') AS table_name");
    if (storeId && existing.rows[0].table_name && !storageIdentity.rows[0].table_name)
      throw new Error('PostgreSQL database does not match this deployment storage identity.');
    await client.query('CREATE TABLE IF NOT EXISTS convoy_storage_identity (id text NOT NULL)');
    if (storeId && !storageIdentity.rows[0].table_name)
      await client.query('INSERT INTO convoy_storage_identity (id) VALUES ($1)', [storeId]);
    if (storeId) {
      const identities = await client.query('SELECT id FROM convoy_storage_identity');
      if (identities.rows.length !== 1 || identities.rows[0].id !== storeId)
        throw new Error('PostgreSQL database does not match this deployment storage identity.');
    }
    if (existing.rows[0].table_name && !schemaInfo.rows[0].table_name)
      throw new Error('PostgreSQL runtime schema metadata is missing. Refusing to replace it.');
    await client.query('CREATE TABLE IF NOT EXISTS convoy_schema_info (version integer NOT NULL)');
    if (!schemaInfo.rows[0].table_name)
      await client.query('INSERT INTO convoy_schema_info (version) VALUES (1)');
    const versions = await client.query('SELECT version FROM convoy_schema_info');
    if (versions.rows.length !== 1 || versions.rows[0].version !== 1)
      throw new Error('Unsupported PostgreSQL runtime schema version.');
    await client.query(`CREATE TABLE IF NOT EXISTS convoy_state_items (
      bucket text NOT NULL, item_key text NOT NULL, ordinal integer NOT NULL,
      payload text NOT NULL, PRIMARY KEY (bucket, item_key)
    )`);
    if (existing.rows[0].table_name) {
      const count = await client.query('SELECT count(*)::integer AS count FROM convoy_state_items');
      if (count.rows[0].count === 0 && !(migrationMode && seedState))
        throw new Error('PostgreSQL runtime state is empty. Refusing to replace it.');
    }
    let legacyState;
    if (importLegacy) {
      const count = await client.query('SELECT count(*)::integer AS count FROM convoy_state_items');
      if (count.rows[0].count !== 0) throw new Error('Cannot import legacy state into a non-empty database.');
      try { legacyState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
      catch (error) { throw new Error(`Cannot import legacy state: ${error.message}`); }
    }
    return await createRowStore({
      load: async () => (await client.query('SELECT bucket,item_key,ordinal,payload FROM convoy_state_items')).rows.map((row) => ({
        bucket: row.bucket, key: row.item_key, position: row.ordinal, payload: row.payload,
      })),
      commit: async (changed, removed) => {
        await client.query('BEGIN');
        try {
          for (let offset = 0; offset < removed.length; offset += 250) {
            const batch = removed.slice(offset, offset + 250);
            const args = batch.flatMap((row) => [row.bucket, row.key]);
            const tuples = batch.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2})`).join(',');
            await client.query(`DELETE FROM convoy_state_items WHERE (bucket,item_key) IN (${tuples})`, args);
          }
          for (let offset = 0; offset < changed.length; offset += 250) {
            const batch = changed.slice(offset, offset + 250);
            const args = batch.flatMap((row) => [row.bucket, row.key, row.position, row.payload]);
            const tuples = batch.map((_, index) => `($${index * 4 + 1},$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4})`).join(',');
            await client.query(`INSERT INTO convoy_state_items (bucket,item_key,ordinal,payload) VALUES ${tuples}
              ON CONFLICT (bucket,item_key) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload`, args);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      },
      close: async () => { closing = true; await client.end(); },
    }, fallback, seedState ?? legacyState, fatal);
  } catch (error) {
    closing = true;
    await client.end();
    throw error;
  }
}
