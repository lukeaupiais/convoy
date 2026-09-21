import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
export async function createStore(directory, fallback) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Runtime state is unreadable. Refusing to replace it.'); data = fallback; }
  let queue = Promise.resolve();
  return {
    data,
    save() {
      const snapshot = JSON.stringify(data);
      const next = queue.catch(() => {}).then(async () => {
        const temp = path + '.tmp'; const file = await open(temp, 'w', 0o600);
        try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
        await rename(temp, path); const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      });
      queue = next; return next;
    },
  };
}
