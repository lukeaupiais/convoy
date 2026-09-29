import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRunner, processRun, digest } from '../../packages/runner/src/index.mjs';

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'convoy-guidance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await processRun('git', ['init', '-q', root]);
  await processRun(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ],
    { cwd: root },
  );
  return root;
}
const capture = (workspace) => executeRunner({ action: 'workspace_guidance', workspace });

test('capture is bounded, UTF-8, regular-file-only and never follows symlinks', async (t) => {
  const root = await repository(t);
  assert.equal((await capture(root)).status, 'missing');
  const path = join(root, 'AGENTS.md');
  for (const invalid of [Buffer.alloc(32769, 65), Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, invalid);
    await assert.rejects(capture(root));
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(capture(root), /regular file/);
  await rm(path, { recursive: true });
  await writeFile(join(root, 'outside'), 'not guidance');
  await symlink('outside', path);
  await assert.rejects(capture(root));
  await rm(path);
  await writeFile(path, '');
  assert.equal((await capture(root)).hash, digest(''));
  await writeFile(path, 'Use the README.');
  assert.deepEqual(await capture(root), {
    status: 'loaded',
    path: 'AGENTS.md',
    content: 'Use the README.',
    hash: digest('Use the README.'),
  });
});

test('opt-in bootstrap carries only local root guidance into fresh worktrees, once', async (t) => {
  const root = await repository(t);
  await writeFile(join(root, '.gitignore'), 'AGENTS.md\n');
  await writeFile(join(root, 'AGENTS.md'), 'Local instructions');
  const provision = (workspaceId, enabled) =>
    executeRunner({
      action: 'provision',
      repository: root,
      workspaceId,
      loadWorkspaceAgentsMd: enabled,
    });
  const off = await provision('off', false);
  assert.equal((await capture(off.path)).status, 'missing');
  const on = await provision('on', true);
  assert.equal(on.guidanceBootstrap.kind, 'seeded');
  assert.equal(on.guidanceBootstrap.sourceHash, digest('Local instructions'));
  assert.equal((await capture(on.path)).content, 'Local instructions');
  await writeFile(join(root, 'AGENTS.md'), 'Changed source');
  assert.equal((await provision('on', true)).guidanceBootstrap.hash, on.guidanceBootstrap.hash);
  assert.equal((await capture(on.path)).content, 'Local instructions');
  await processRun('git', ['add', '-f', 'AGENTS.md'], { cwd: root });
  await processRun(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'guidance',
    ],
    { cwd: root },
  );
  const tracked = await provision('tracked', true);
  assert.equal(tracked.guidanceBootstrap.kind, 'workspace');
  assert.equal((await capture(tracked.path)).content, 'Changed source');
});

test('prepared bootstrap journal reconciles exact created file, rejects conflicts and does not overwrite', async (t) => {
  const root = await repository(t);
  const workspaceId = 'recovery';
  const workspace = await executeRunner({ action: 'provision', repository: root, workspaceId });
  const journalDirectory = join(root, '.convoy-worktrees', '.guidance');
  await mkdir(journalDirectory);
  const journal = join(journalDirectory, `${workspaceId}.json`);
  const prepared = {
    repository: root,
    workspace: workspace.path,
    state: 'prepared',
    content: 'Seed',
    hash: digest('Seed'),
  };
  await writeFile(journal, JSON.stringify(prepared));
  await writeFile(join(workspace.path, 'AGENTS.md'), 'Conflicting file');
  await assert.rejects(
    executeRunner({
      action: 'provision',
      repository: root,
      workspaceId,
      loadWorkspaceAgentsMd: true,
    }),
    /conflicts/,
  );
  assert.equal(await readFile(join(workspace.path, 'AGENTS.md'), 'utf8'), 'Conflicting file');
  await writeFile(join(workspace.path, 'AGENTS.md'), 'Seed');
  const recovered = await executeRunner({
    action: 'provision',
    repository: root,
    workspaceId,
    loadWorkspaceAgentsMd: true,
  });
  assert.equal(recovered.guidanceBootstrap.kind, 'seeded');
  assert.equal(JSON.parse(await readFile(journal, 'utf8')).state, 'complete');
});

test('bootstrap journal rejects oversized files, FIFOs and symlinked directories', async (t) => {
  const root = await repository(t);
  const workspaceId = 'invalid-journal';
  await executeRunner({ action: 'provision', repository: root, workspaceId });
  const directory = join(root, '.convoy-worktrees', '.guidance');
  await mkdir(directory);
  const journal = join(directory, `${workspaceId}.json`);
  const provision = () =>
    executeRunner({
      action: 'provision',
      repository: root,
      workspaceId,
      loadWorkspaceAgentsMd: true,
    });
  await writeFile(journal, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(provision(), /journal/);
  await rm(journal);
  assert.equal((await processRun('mkfifo', [journal])).code, 0);
  await assert.rejects(provision(), /journal/);
  await rm(directory, { recursive: true });
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, directory);
  await assert.rejects(provision());
});
