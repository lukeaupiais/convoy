import { constants } from 'node:fs';
import { open, realpath, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LIMIT = 32 * 1024;

// Open through a held directory descriptor, reject links/nonregular files, and
// bound the read itself. No unbounded readFile or stat-then-follow race.
export async function readWorkspaceGuidance(root) {
  const base = await realpath(root);
  const directory = await open(
    base,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let file;
  try {
    try {
      file = await open(
        `/proc/self/fd/${directory.fd}/AGENTS.md`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing', path: 'AGENTS.md' };
      throw error;
    }
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT)
      throw new Error('AGENTS.md must be a regular file with one link, at most 32 KiB.');
    const bytes = Buffer.alloc(LIMIT + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    if (
      total > LIMIT ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('AGENTS.md changed during capture or exceeds 32 KiB.');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, total),
    );
    return { status: 'loaded', path: 'AGENTS.md', hash: hash(bytes.subarray(0, total)), content };
  } finally {
    await file?.close();
    await directory.close();
  }
}

async function persist(path, value, directory) {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await directory.sync();
}

// Provisioning is a daemon-authorized bootstrap, not an agent write. Journal the
// intended seed outside the worktree so a retry cannot reinterpret partial work.
export async function seedWorkspaceGuidance(repository, workspace, workspaceId, git, signal) {
  const parent = await open(
    join(repository, '.convoy-worktrees'),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let records;
  try {
    const path = `/proc/self/fd/${parent.fd}/.guidance`;
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    records = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } finally {
    await parent.close();
  }
  try {
    const journal = `/proc/self/fd/${records.fd}/${workspaceId}.json`;
    let record;
    let file;
    try {
      file = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
        throw new Error('Invalid guidance journal file.');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > 256 * 1024) throw new Error('Guidance journal is too large.');
      record = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)),
      );
      if (
        !record ||
        !['prepared', 'complete'].includes(record.state) ||
        (record.state === 'prepared' &&
          (typeof record.content !== 'string' ||
            Buffer.byteLength(record.content) > LIMIT ||
            !/^[a-f0-9]{64}$/.test(record.hash ?? ''))) ||
        (record.state === 'complete' &&
          !['workspace', 'missing', 'seeded'].includes(record.result?.kind))
      )
        throw new Error('Invalid guidance journal record.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      await file?.close();
    }
    if (record && (record.repository !== repository || record.workspace !== workspace))
      throw new Error('Guidance bootstrap identity mismatch.');
    if (record?.state === 'complete') return record.result;
    const target = await readWorkspaceGuidance(workspace);
    if (!record) {
      let source;
      if (target.status === 'loaded') {
        record = {
          repository,
          workspace,
          state: 'complete',
          result: { kind: 'workspace', hash: target.hash },
        };
      } else {
        const tracked = await git(
          repository,
          ['ls-files', '--error-unmatch', '--', 'AGENTS.md'],
          signal,
        );
        if (tracked.code !== 0 && tracked.code !== 1)
          throw new Error('Unable to establish guidance tracking.');
        if (tracked.code === 1) source = await readWorkspaceGuidance(repository);
        if (source?.status === 'loaded') {
          record = {
            repository,
            workspace,
            state: 'prepared',
            content: source.content,
            hash: source.hash,
          };
        } else record = { repository, workspace, state: 'complete', result: { kind: 'missing' } };
      }
      await persist(journal, record, records);
    }
    if (record.state === 'complete') return record.result;
    if (hash(Buffer.from(record.content)) !== record.hash)
      throw new Error('Guidance bootstrap journal is corrupt.');
    if (target.status === 'loaded') {
      if (target.hash !== record.hash)
        throw new Error('Guidance seed conflicts with existing workspace content.');
    } else {
      const directory = await open(
        workspace,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let targetFile;
      try {
        targetFile = await open(
          `/proc/self/fd/${directory.fd}/AGENTS.md`,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await targetFile.writeFile(record.content);
        await targetFile.sync();
        await directory.sync();
      } finally {
        await targetFile?.close();
        await directory.close();
      }
    }
    const verified = await readWorkspaceGuidance(workspace);
    if (verified.hash !== record.hash) throw new Error('Guidance seed verification failed.');
    const result = {
      kind: 'seeded',
      repository,
      path: 'AGENTS.md',
      sourceHash: record.hash,
      hash: verified.hash,
    };
    await persist(journal, { repository, workspace, state: 'complete', result }, records);
    return result;
  } finally {
    await records.close();
  }
}
