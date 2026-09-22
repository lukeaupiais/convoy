import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createCommandLogs } from './command-logs.mjs';
import { createContextFiles } from './context-files.mjs';
import { createStore } from './store.mjs';
import { createSqliteStore } from './sqlite-store.mjs';
import { createPostgresStore } from './postgres-store.mjs';

/** Build the daemon's persistence ports. Only the composition root calls this. */
export async function createPersistence({ directory, legacyDirectory, initialState, backend = 'file', databaseUrl, importLegacy = false, onFatal }) {
  if (!['file', 'sqlite', 'postgres'].includes(backend))
    throw new Error('Unknown persistence backend.');
  if (backend === 'file') {
    try {
      await readFile(join(directory, 'storage.json'));
      throw new Error('Database-backed state exists here. Refusing to use the legacy file backend.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let storeId;
  let existingMarker = false;
  if (backend !== 'file') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const markerPath = join(directory, 'storage.json');
    let marker;
    try { marker = JSON.parse(await readFile(markerPath, 'utf8')); existingMarker = true; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Persistence identity is unreadable. Refusing to replace it.');
      if (backend === 'postgres' && !importLegacy) {
        try {
          await readFile(join(directory, 'state.json'));
          throw new Error('Legacy state exists. Set CONVOY_IMPORT_LEGACY_STATE=1 for explicit PostgreSQL import.');
        } catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
      }
      marker = { version: 1, backend, storeId: randomUUID() };
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
      const file = await open(markerPath, 'r');
      try { await file.sync(); } finally { await file.close(); }
    }
    if (marker.version !== 1 || marker.backend !== backend || typeof marker.storeId !== 'string')
      throw new Error('Persistence backend or identity changed. Explicit migration is required.');
    storeId = marker.storeId;
  }
  const store = backend === 'sqlite'
    ? await createSqliteStore(directory, initialState, storeId, existingMarker, onFatal)
    : backend === 'postgres'
      ? await createPostgresStore(directory, initialState, databaseUrl, importLegacy, storeId, existingMarker, onFatal)
      : backend === 'file'
        ? await createStore(directory, initialState)
        : undefined;
  return {
    store,
    contextFiles: createContextFiles(directory),
    commandLogs: createCommandLogs(join(directory, 'command-logs')),
    async readLegacyConversation(id) {
      if (!legacyDirectory) return null;
      try {
        return JSON.parse(await readFile(join(legacyDirectory, `${id}.json`), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Legacy history could not be imported. It was not changed.');
      }
    },
  };
}
