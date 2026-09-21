import { mkdir, appendFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function createCommandLogs(directory) {
  const ready = mkdir(directory, { recursive: true, mode: 0o700 });
  const path = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid command ID.');
    return join(directory, id + '.log');
  };
  return {
    async append(id, chunks) {
      await ready;
      const output = chunks.map(c => c.text).join('');
      await appendFile(path(id), output, { mode: 0o600 });
    },
    async remove(id) { await unlink(path(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
    async read(id, cursor = 0) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid log cursor.');
      const file = await open(path(id), 'r');
      try {
        const { size } = await file.stat();
        if (cursor > size) throw new Error('Invalid log cursor.');
        const buffer = Buffer.alloc(Math.min(32768, size - cursor));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
        let end = bytesRead;
        if (end && (buffer[0] & 0xc0) === 0x80) throw new Error('Cursor must be on a UTF-8 boundary.');
        const decoder = new TextDecoder('utf-8', { fatal: true }); let text;
        for (let trim = 0; trim <= 3; trim++) {
          try { text = decoder.decode(buffer.subarray(0, end)); break; } catch { end--; }
        }
        if (text === undefined) throw new Error('Invalid UTF-8 log.');
        return { text, cursor: cursor + end, hasMore: cursor + end < size, size };
      } finally { await file.close(); }
    },
  };
}
