import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeRunner,
  processRun,
  digest,
  runAgentLoop,
} from '../../packages/runner/src/index.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { sshArgs } from '../../packages/runner/src/index.mjs';
import { createRpc } from '../../packages/runner/src/index.mjs';
import { spawn } from 'node:child_process';
test('portable adapter transports JSON without interpolating request values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-ssh-contract-'));
  await writeFile(join(root, 'hello.txt'), 'remote-contract');
  const adapter = createRunners({
    deployment: { ensure: async () => ({}) },
    connect: () => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['apps/worker/src/worker.mjs'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env,
      });
      const rpc = createRpc(child.stdout, child.stdin);
      return {
        call: rpc.call,
        close: () => {
          child.stdin.end();
          child.kill();
          rpc.close();
        },
      };
    },
  });
  t.after(() => adapter.close());
  const result = await adapter.execute(
    { kind: 'ssh', host: 'test-host' },
    { action: 'tool', workspace: root, name: 'read_file', args: { path: 'hello.txt' } },
  );
  assert.equal(result.text, 'remote-contract');
  const remotePatch = await adapter.execute(
    { kind: 'ssh', host: 'test-host' },
    {
      action: 'tool',
      workspace: root,
      name: 'apply_patch',
      args: {
        path: 'hello.txt',
        expectedHash: result.sha256,
        edits: [{ oldText: 'remote', newText: 'portable' }],
      },
    },
  );
  assert.equal(remotePatch.replacements, 1);
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'portable-contract');
  await assert.rejects(sshArgs('host;touch /tmp/bad'), /Invalid SSH/);
  assert.ok((await sshArgs('fixture')).includes('StrictHostKeyChecking=yes'));
});
test('runner extensions dispatch only to explicitly installed adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-extension-runner-'));
  const request = {
    action: 'extension',
    workspace: root,
    extension: { id: 'review-mcp', revision: 'sha256:1', hash: 'a'.repeat(64) },
    adapter: 'mcp-stdio',
    tool: 'review.findings',
    args: { path: 'README.md' },
  };
  await assert.rejects(executeRunner(request), /not installed/);
  const result = await executeRunner(request, undefined, undefined, undefined, {
    'mcp-stdio': async ({ extension, tool, args, workspace }) => ({
      extension,
      tool,
      args,
      workspace,
    }),
  });
  assert.equal(result.extension.id, 'review-mcp');
  assert.equal(result.tool, 'review.findings');
  assert.equal(result.args.path, 'README.md');
});
test('runner worktree isolation, path/link guards, stale writes, search and fingerprint', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-runner-test-'));
  await processRun('git', ['init', repository]);
  await writeFile(join(repository, 'README.md'), '# Fixture\nhello');
  await processRun('git', ['add', 'README.md'], { cwd: repository });
  const commit = await processRun(
    'git',
    [
      '-c',
      'user.name=Convoy Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: repository },
  );
  assert.equal(commit.code, 0);
  const capabilities = await executeRunner({ action: 'probe', repository });
  assert.ok(capabilities.tools.includes('read_file'));
  assert.ok(capabilities.tools.includes('apply_patch'));
  const workspace = await executeRunner({
    action: 'provision',
    repository,
    workspaceId: 'test-task',
  });
  assert.deepEqual(
    await executeRunner({ action: 'provision', repository, workspaceId: 'test-task' }),
    workspace,
  );
  const tool = (name, args) =>
    executeRunner({ action: 'tool', workspace: workspace.path, name, args });
  assert.equal((await tool('read_file', { path: 'README.md' })).sha256, digest('# Fixture\nhello'));
  await assert.rejects(
    tool('apply_patch', {
      path: 'README.md',
      expectedHash: '0'.repeat(64),
      edits: [{ oldText: 'hello', newText: 'ship' }],
    }),
    /changed/,
  );
  const patched = await tool('apply_patch', {
    path: 'README.md',
    expectedHash: digest('# Fixture\nhello'),
    edits: [
      { oldText: '# Fixture', newText: '# Convoy' },
      { oldText: 'hello', newText: 'ship' },
    ],
  });
  assert.equal(patched.replacements, 2);
  assert.equal(patched.sha256, digest('# Convoy\nship'));
  assert.equal(await readFile(join(workspace.path, 'README.md'), 'utf8'), '# Convoy\nship');
  await tool('write_file', { path: 'ambiguous.txt', content: 'same same', expectedHash: '' });
  await assert.rejects(
    tool('apply_patch', {
      path: 'ambiguous.txt',
      expectedHash: digest('same same'),
      edits: [{ oldText: 'same', newText: 'changed' }],
    }),
    /ambiguous/,
  );
  assert.equal(await readFile(join(workspace.path, 'ambiguous.txt'), 'utf8'), 'same same');
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    executeRunner(
      {
        action: 'tool',
        workspace: workspace.path,
        name: 'apply_patch',
        args: {
          path: 'README.md',
          expectedHash: patched.sha256,
          edits: [{ oldText: 'ship', newText: 'stopped' }],
        },
      },
      stopped.signal,
    ),
    /Stopped/,
  );
  assert.equal(await readFile(join(workspace.path, 'README.md'), 'utf8'), '# Convoy\nship');
  await assert.rejects(tool('read_file', { path: '../README.md' }), /inside/);
  await assert.rejects(tool('read_file', { path: '/etc/passwd' }), /inside/);
  await assert.rejects(tool('read_file', { path: '.git' }), /inside/);
  await symlink(join(repository, 'README.md'), join(workspace.path, 'escape'));
  await assert.rejects(tool('read_file', { path: 'escape' }), /Symlinks/);
  await link(join(repository, 'README.md'), join(workspace.path, 'hardlink'));
  await assert.rejects(
    tool('write_file', { path: 'hardlink', content: 'bad', expectedHash: '' }),
    /hardlinks/,
  );
  await assert.rejects(
    tool('write_file', { path: 'README.md', content: 'bad', expectedHash: 'stale' }),
    /changed/,
  );
  await tool('write_file', {
    path: 'notes/new.md',
    content: '# Scope\nhello test',
    expectedHash: '',
  });
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), '# Fixture\nhello');
  assert.ok(
    (await tool('search_files', { query: 'hello test' })).hits.some(
      (h) => h.path === 'notes/new.md',
    ),
  );
  const before = await executeRunner({ action: 'diff', workspace: workspace.path });
  await tool('write_file', {
    path: 'notes/new.md',
    content: 'changed',
    expectedHash: digest('# Scope\nhello test'),
  });
  const after = await executeRunner({ action: 'diff', workspace: workspace.path });
  assert.notEqual(before.digest, after.digest);
  if (capabilities.shell) {
    const shell = await tool('shell', {
      command:
        'test ! -e /etc/passwd && test ! -d /home && test "$(git rev-parse --show-toplevel)" = /workspace && git status --short >/dev/null && ! git add README.md 2>/dev/null && printf shell-ok',
    });
    assert.equal(shell.code, 0);
    assert.equal(shell.output, 'shell-ok');
  } else await assert.rejects(tool('shell', { command: 'printf should-not-run' }), /Sandbox/);
});

test('trusted runner commands receive host execution without inheriting secret environment values', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-trusted-runner-'));
  await processRun('git', ['init', repository]);
  const previousVisible = process.env.CONVOY_TEST_VALUE;
  const previousSecret = process.env.CONVOY_TEST_SECRET;
  process.env.CONVOY_TEST_VALUE = 'available';
  process.env.CONVOY_TEST_SECRET = 'must-not-leak';
  t.after(() => {
    if (previousVisible === undefined) delete process.env.CONVOY_TEST_VALUE;
    else process.env.CONVOY_TEST_VALUE = previousVisible;
    if (previousSecret === undefined) delete process.env.CONVOY_TEST_SECRET;
    else process.env.CONVOY_TEST_SECRET = previousSecret;
  });

  const adapter = createRunners();
  t.after(() => adapter.close());
  const runner = { id: 'trusted', kind: 'local', host: '', accessMode: 'trusted' };
  const capabilities = await adapter.execute(runner, { action: 'probe', repository });
  assert.equal(capabilities.accessMode, 'trusted');
  assert.equal(capabilities.shell, true);
  const result = await adapter.execute(runner, {
    action: 'tool',
    workspace: repository,
    name: 'shell',
    args: {
      command:
        'test -r /etc/os-release && test "$CONVOY_TEST_VALUE" = available && test -z "${CONVOY_TEST_SECRET:-}" && git rev-parse --is-inside-work-tree',
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), 'true');
});
test('a trusted runner preserves an explicitly requested contained grant', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'convoy-trusted-contained-'));
  const adapter = createRunners();
  t.after(() => adapter.close());
  const runner = { id: 'dual-authority', kind: 'local', host: '', accessMode: 'trusted' };
  const contained = await adapter.execute(runner, {
    action: 'tool',
    workspace,
    name: 'shell',
    args: { command: 'test ! -e /etc/passwd' },
    accessMode: 'contained',
  });
  const host = await adapter.execute(runner, {
    action: 'tool',
    workspace,
    name: 'shell',
    args: { command: 'test -e /etc/passwd' },
    accessMode: 'trusted',
  });
  assert.equal(contained.code, 0);
  assert.equal(host.code, 0);
});

test('agent loop runs declared independent tools concurrently but orders mutations', async () => {
  async function duration(tools, parallelTools) {
    const started = [];
    const at = performance.now();
    await runAgentLoop({ maxRounds: 1, parallelTools }, async (method) => {
      if (method === 'generate')
        return {
          content: tools.map((name, index) => ({
            type: 'toolCall',
            id: String(index),
            name,
            arguments: {},
          })),
        };
      if (method === 'tool') {
        started.push(performance.now() - at);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {};
      }
      if (method === 'afterRound') return true;
    });
    return { elapsed: performance.now() - at, started };
  }

  const concurrent = await duration(['read_file', 'search_files'], ['read_file', 'search_files']);
  assert.ok(concurrent.elapsed < 180, JSON.stringify(concurrent));
  assert.ok(concurrent.started[1] < 40, JSON.stringify(concurrent));

  const ordered = await duration(['write_file', 'apply_patch'], []);
  assert.ok(ordered.elapsed >= 190, JSON.stringify(ordered));
  assert.ok(ordered.started[1] >= 90, JSON.stringify(ordered));
});

test('agent loop bounds independent tool fan-out at eight', async () => {
  let active = 0;
  let peak = 0;
  await runAgentLoop({ maxRounds: 1, parallelTools: ['read_file'] }, async (method) => {
    if (method === 'generate')
      return {
        content: Array.from({ length: 20 }, (_, index) => ({
          type: 'toolCall',
          id: String(index),
          name: 'read_file',
          arguments: { path: `${index}.txt` },
        })),
      };
    if (method === 'tool') {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {};
    }
    if (method === 'afterRound') return true;
  });
  assert.equal(peak, 8);
});

test('workspace exploration pages large files, filters paths, searches regex and exposes read-only Git evidence', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-exploration-'));
  await processRun('git', ['init', repository]);
  await mkdir(join(repository, 'src'));
  const large = Array.from({ length: 3000 }, (_, index) => `${index + 1}: café`).join('\n');
  await writeFile(join(repository, 'src', 'large.txt'), large);
  await writeFile(join(repository, 'src', 'match.ts'), 'before\nHello   World\nafter\n');
  await writeFile(join(repository, 'README.md'), '# Fixture\n');
  await processRun('git', ['add', '.'], { cwd: repository });
  assert.equal(
    (
      await processRun(
        'git',
        [
          '-c',
          'user.name=Convoy Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-m',
          'fixture',
        ],
        { cwd: repository },
      )
    ).code,
    0,
  );
  await writeFile(join(repository, 'README.md'), '# Changed\n');
  const tool = (name, args) => executeRunner({ action: 'tool', workspace: repository, name, args });

  const page = await tool('read_file', { path: 'src/large.txt', offset: 2500, limit: 20 });
  assert.match(page.text, /^2500: café/);
  assert.equal(page.startLine, 2500);
  assert.equal(page.endLine, 2519);
  assert.equal(page.totalLines, 3000);
  assert.equal(page.truncated, true);
  assert.equal(page.nextOffset, 2520);

  await writeFile(join(repository, 'src', 'single-line.txt'), '😀'.repeat(30_000));
  const firstLongPage = await tool('read_file', { path: 'src/single-line.txt' });
  assert.equal(firstLongPage.truncated, true);
  assert.equal(firstLongPage.nextOffset, 1);
  assert.ok(firstLongPage.nextColumn > 0);
  assert.ok(Buffer.byteLength(firstLongPage.text) <= 48_000);
  let longText = firstLongPage.text;
  let longPage = firstLongPage;
  while (longPage.truncated) {
    longPage = await tool('read_file', {
      path: 'src/single-line.txt',
      offset: longPage.nextOffset,
      column: longPage.nextColumn ?? 0,
    });
    longText += longPage.text;
  }
  assert.equal(longText, '😀'.repeat(30_000));

  const listed = await tool('list_files', { path: 'src', glob: '**/*.ts', limit: 20 });
  assert.deepEqual(listed.paths, ['src/match.ts']);
  assert.equal(listed.truncated, false);

  const searched = await tool('search_files', {
    query: 'hello\\s+world',
    path: 'src',
    glob: '**/*.ts',
    regex: true,
    caseSensitive: false,
    context: 1,
    limit: 20,
  });
  assert.equal(searched.hits[0].path, 'src/match.ts');
  assert.equal(searched.hits[0].line, 2);
  assert.deepEqual(searched.hits[0].before, ['before']);
  assert.deepEqual(searched.hits[0].after, ['after']);

  const status = await tool('inspect_repository', { operation: 'status' });
  assert.match(status.output, /README\.md/);
  const diff = await tool('inspect_repository', { operation: 'diff' });
  assert.match(diff.output, /# Fixture/);
  assert.match(diff.output, /# Changed/);
  const log = await tool('inspect_repository', { operation: 'log', limit: 5 });
  assert.match(log.output, /fixture/);
});

test('apply_patch validates every file before committing a multi-file patch', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-patch-set-'));
  await processRun('git', ['init', repository]);
  await writeFile(join(repository, 'one.txt'), 'one before\n');
  await writeFile(join(repository, 'two.txt'), 'two before\n');
  const tool = (args) =>
    executeRunner({ action: 'tool', workspace: repository, name: 'apply_patch', args });
  const oneHash = digest('one before\n');
  const twoHash = digest('two before\n');

  await assert.rejects(
    tool({
      operations: [
        {
          path: 'one.txt',
          expectedHash: oneHash,
          edits: [{ oldText: 'before', newText: 'after' }],
        },
        {
          path: 'two.txt',
          expectedHash: '0'.repeat(64),
          edits: [{ oldText: 'before', newText: 'after' }],
        },
      ],
    }),
    /changed since it was read/,
  );
  assert.equal(await readFile(join(repository, 'one.txt'), 'utf8'), 'one before\n');

  const changed = await tool({
    operations: [
      {
        path: 'one.txt',
        expectedHash: oneHash,
        edits: [{ oldText: 'before', newText: 'after' }],
      },
      {
        path: 'two.txt',
        expectedHash: twoHash,
        edits: [{ oldText: 'before', newText: 'after' }],
      },
    ],
  });
  assert.equal(changed.files.length, 2);
  assert.equal(changed.replacements, 2);
  assert.equal(await readFile(join(repository, 'one.txt'), 'utf8'), 'one after\n');
  assert.equal(await readFile(join(repository, 'two.txt'), 'utf8'), 'two after\n');
});

test('apply_patch can add, delete and move files with guarded sources', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-file-operations-'));
  await processRun('git', ['init', repository]);
  await writeFile(join(repository, 'delete.txt'), 'remove me\n');
  await writeFile(join(repository, 'move.txt'), 'move me\n');
  const result = await executeRunner({
    action: 'tool',
    workspace: repository,
    name: 'apply_patch',
    args: {
      operations: [
        { operation: 'add', path: 'nested/added.txt', content: 'created\n' },
        {
          operation: 'delete',
          path: 'delete.txt',
          expectedHash: digest('remove me\n'),
        },
        {
          operation: 'move',
          path: 'move.txt',
          to: 'nested/moved.txt',
          expectedHash: digest('move me\n'),
        },
      ],
    },
  });
  assert.deepEqual(
    result.files.map((file) => [file.operation, file.path, file.to]),
    [
      ['add', 'nested/added.txt', undefined],
      ['delete', 'delete.txt', undefined],
      ['move', 'move.txt', 'nested/moved.txt'],
    ],
  );
  assert.equal(await readFile(join(repository, 'nested/added.txt'), 'utf8'), 'created\n');
  await assert.rejects(readFile(join(repository, 'delete.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(repository, 'move.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(repository, 'nested/moved.txt'), 'utf8'), 'move me\n');
});
