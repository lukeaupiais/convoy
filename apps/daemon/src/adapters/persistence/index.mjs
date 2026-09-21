import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCommandLogs } from './command-logs.mjs';
import { createContextFiles } from './context-files.mjs';
import { createStore } from './store.mjs';

/** Build the daemon's persistence ports. Only the composition root calls this. */
export async function createPersistence({ directory, legacyDirectory, initialState }) {
  const store = await createStore(directory, initialState);
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
