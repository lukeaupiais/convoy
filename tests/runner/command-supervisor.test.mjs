import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CommandSupervisor } from '../../packages/runner/src/index.mjs';
import { createCommandLogs } from '../../apps/daemon/src/adapters/persistence/command-logs.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { createRpc } from '../../packages/runner/src/index.mjs';
import { executeRunner } from '../../packages/runner/src/index.mjs';

async function drain(supervisor, id, owner = 'test') {
  let cursor = 0;
  const chunks = [];
  let result;
  do {
    result = await supervisor.poll(id, owner, { cursor, waitMs: 100 });
    cursor = result.cursor;
    chunks.push(...result.chunks);
  } while (result.state !== 'exited' || result.hasMore);
  return { ...result, chunks };
}

test('yield does not kill; stdout/stderr and split UTF-8 replay beyond 64 KB', async (t) => {
  const s = new CommandSupervisor();
  t.after(() => s.close());
  const id = s.start(
    process.execPath,
    [
      '-e',
      `process.stdout.write('x'.repeat(100000));process.stderr.write('warning');process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.end(Buffer.from([0x98,0x80])),150);`,
    ],
    { owner: 'test' },
  );
  const early = await s.poll(id, 'test', { waitMs: 1 });
  assert.equal(early.state, 'running');
  const result = await drain(s, id);
  assert.equal(result.code, 0);
  assert.equal(result.stopped, false);
  assert.equal(
    result.chunks
      .filter((c) => c.stream === 'stdout')
      .map((c) => c.text)
      .join(''),
    'x'.repeat(100000) + '😀',
  );
  assert.equal(
    result.chunks
      .filter((c) => c.stream === 'stderr')
      .map((c) => c.text)
      .join(''),
    'warning',
  );
  const replay = await drain(s, id);
  assert.deepEqual(replay.chunks, result.chunks);
  await assert.rejects(s.poll(id, 'someone-else'), /belong/);
  await assert.rejects(s.poll(id, 'test', { cursor: 99999 }), /cursor/);
});

test('graceful stop preserves exit code but is not successful check evidence', async (t) => {
  const s = new CommandSupervisor({ graceMs: 100 });
  t.after(() => s.close());
  const id = s.start(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000);`,
    ],
    { owner: 'test' },
  );
  while (!(await s.poll(id, 'test', { waitMs: 100 })).chunks.length) {}
  await s.stop(id, 'test');
  const result = await drain(s, id);
  assert.equal(result.code, 0);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.stopped, true);
});

test('duplicate launch identity is deduplicated only within the living supervisor', async (t) => {
  const s = new CommandSupervisor();
  t.after(() => s.close());
  const options = { owner: 'test', launchId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const id = s.start('/bin/sh', ['-c', 'printf once'], options);
  assert.equal(s.start('/bin/sh', ['-c', 'printf once'], options), id);
  assert.throws(() => s.start('/bin/sh', ['-c', 'printf twice'], options), /different/);
  assert.equal((await drain(s, id)).chunks.map((c) => c.text).join(''), 'once');
});

test('session commands accept bounded stdin after launch', async (t) => {
  const supervisor = new CommandSupervisor();
  t.after(() => supervisor.close());
  const id = supervisor.start('/bin/cat', [], { owner: 'test', lifetime: 'session' });
  await supervisor.input(id, 'test', 'ship\n', true);
  const result = await drain(supervisor, id);
  assert.equal(result.code, 0);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), 'ship\n');
  await assert.rejects(supervisor.input(id, 'another-owner', 'nope'), /belong/);
});

test('deadline escalates to SIGKILL and quota has its own explicit failure reason', async (t) => {
  const s = new CommandSupervisor({ graceMs: 30, quotaBytes: 1024 });
  t.after(() => s.close());
  const deadline = s.start(
    process.execPath,
    ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],
    { owner: 'test', timeoutMs: 300 },
  );
  const result = await drain(s, deadline);
  assert.equal(result.reason, 'deadline');
  assert.equal(result.signal, 'SIGKILL');
  const quota = s.start(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000);`],
    { owner: 'test' },
  );
  assert.equal((await drain(s, quota)).reason, 'output_quota');
});

test('pre-aborted launches never spawn; missing executables settle; close reaps children', async () => {
  const s = new CommandSupervisor({ graceMs: 30 });
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => s.start('/bin/sh', ['-c', 'exit 0'], { signal: controller.signal }),
    /stopped/,
  );
  const missing = s.start('/missing-convoy-command', [], { owner: 'test' });
  assert.equal((await drain(s, missing)).reason, 'spawn_error');
  const id = s.start('/bin/sh', ['-c', 'sleep 100 & echo $!; wait'], { owner: 'test' });
  let output;
  while (
    !(output = (await s.poll(id, 'test', { waitMs: 100 })).chunks.map((c) => c.text).join(''))
  ) {}
  const child = Number(output.trim());
  await s.close();
  // A dead descendant may briefly be a zombie under a container's PID 1;
  // the owned group must not contain a running command.
  try {
    const { readFile } = await import('node:fs/promises');
    const stat = await readFile(`/proc/${child}/stat`, 'utf8');
    assert.match(stat, /\) Z /);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
});

test('retained coordinator logs page UTF-8 safely and survive reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-command-logs-test-'));
  const logs = createCommandLogs(root);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const text = '😀'.repeat(20000) + 'done';
  await logs.append(id, [{ text }]);
  let cursor = 0;
  let actual = '';
  let page;
  do {
    page = await createCommandLogs(root).read(id, cursor);
    actual += page.text;
    cursor = page.cursor;
  } while (page.hasMore);
  assert.equal(actual, text);
  await assert.rejects(logs.read(id, 1), /boundary/);
  await logs.remove(id);
  await assert.rejects(logs.read(id), { code: 'ENOENT' });
});

for (const kind of ['local', 'ssh', 'compiled'])
  test(`${kind} adapter streams sandboxed output, cancels and returns final identity`, async (t) => {
    if (kind === 'compiled' && !existsSync('dist-worker/convoy-worker-linux-x64')) {
      t.skip('Build the worker to test its packaged executable');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'convoy-command-adapter-test-'));
    // Probe the actual sandbox; do not silently fall back to unsandboxed shell.
    let supported = true;
    try {
      await executeRunner({
        action: 'tool',
        workspace: root,
        name: 'shell',
        args: { command: 'true' },
      });
    } catch {
      supported = false;
    }
    if (!supported) {
      t.skip('Bubblewrap unavailable');
      return;
    }
    const runners = createRunners({
      deployment: { ensure: async () => ({}) },
      connect: (_artifact, handlers) => {
        const env = { ...process.env, CONVOY_WORKER_STATE: root };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(
          kind === 'compiled' ? './dist-worker/convoy-worker-linux-x64' : process.execPath,
          kind === 'compiled' ? [] : ['apps/worker/src/worker.mjs'],
          { env, stdio: ['pipe', 'pipe', 'inherit'] },
        );
        const rpc = createRpc(child.stdout, child.stdin, handlers);
        return {
          call: rpc.call,
          close() {
            child.stdin.end();
            rpc.close();
          },
        };
      },
    });
    let seen = '';
    let stopped = false;
    const result = await runners.execute(
      { kind: kind === 'compiled' ? 'ssh' : kind, host: 'fixture' },
      {
        action: 'tool',
        workspace: root,
        name: 'shell',
        args: { command: 'printf ready; sleep 100' },
      },
      undefined,
      async (update, stop) => {
        seen += update.chunks.map((c) => c.text).join('');
        if (seen.includes('ready') && !stopped) {
          stopped = true;
          await stop();
        }
      },
    );
    assert.equal(stopped, true);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.state, 'exited');
    assert.match(result.commandId, /^[a-f0-9-]{36}$/);
  });

test('command remains alive beyond the old 60 second limit', { timeout: 75000 }, async (t) => {
  const s = new CommandSupervisor();
  t.after(() => s.close());
  const id = s.start('/bin/sh', ['-c', 'sleep 61; printf survived'], { owner: 'test' });
  const result = await drain(s, id);
  assert.equal(result.code, 0);
  assert.equal(result.chunks.map((c) => c.text).join(''), 'survived');
});

test('session command survives its local agent turn and remains stoppable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-session-command-test-'));
  let supported = true;
  try {
    await executeRunner({
      action: 'tool',
      workspace: root,
      name: 'shell',
      args: { command: 'true' },
    });
  } catch {
    supported = false;
  }
  if (!supported) {
    t.skip('Bubblewrap unavailable');
    return;
  }
  const runners = createRunners({ idleMs: 20 });
  t.after(() => runners.close());
  const runner = { id: 'local-session', kind: 'local' };
  let executor;
  let stop;
  let final;
  let toolResult;
  await runners.runAgent(
    runner,
    { maxRounds: 1, workspace: root },
    {
      setExecutor: (value) => {
        executor = value;
      },
      prepare: async () => {},
      generate: async () => ({
        content: [
          {
            type: 'toolCall',
            id: 'server',
            name: 'start_command',
            arguments: { command: 'printf ready; sleep 100', yieldMs: 10 },
          },
        ],
      }),
      message: async () => {},
      tool: async ({ call }) => {
        toolResult = await executor(
          runner,
          { action: 'tool', workspace: root, name: call.name, args: call.arguments },
          undefined,
          async (update, control) => {
            stop = control;
            if (update.state === 'exited') final = update;
          },
        );
        return { output: toolResult };
      },
      afterRound: async () => true,
    },
  );
  assert.equal(toolResult.state, 'running');
  assert.equal(runners.backgroundCount(runner.id), 1);
  assert.equal(final, undefined);
  await stop();
  for (let i = 0; i < 100 && !final; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(final.reason, 'cancelled');
  assert.equal(final.state, 'exited');
  assert.equal(runners.backgroundCount(runner.id), 0);
});
