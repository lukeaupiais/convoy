import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  prepareVerificationRuntime,
  runtimeCommand,
  runtimeLifecycle,
  processRun,
  CommandSupervisor,
} from '../../packages/runner/src/index.mjs';

async function fixture(t) {
  if (!process.env.CONVOY_RUNTIME_TEST_IMAGE) {
    assert.notEqual(process.env.CONVOY_REQUIRE_VERIFICATION, '1');
    t.skip('Explicit immutable Docker runtime image required');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'convoy-runtime-race-'));
  await processRun('git', ['init', '-q', dir]);
  await writeFile(join(dir, 'README.md'), 'Generic runtime lifecycle fixture\n');
  await processRun('git', ['-C', dir, 'add', '.']);
  await processRun('git', [
    '-C',
    dir,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const sourceCommit = (await processRun('git', ['-C', dir, 'rev-parse', 'HEAD'])).output.trim();
  const execution = {
    assignmentToken: randomUUID(),
    policyDigest: 'a'.repeat(64),
    grant: {
      profileId: 'verify',
      runtime: {
        required: true,
        definition: {
          digest: 'b'.repeat(64),
          image: process.env.CONVOY_RUNTIME_TEST_IMAGE,
          sourceCommit,
          fixtureDigest: 'c'.repeat(64),
          startup: [],
          readiness: ['/bin/true'],
          guidance: 'Fixture',
          limits: {
            memoryMb: 128,
            scratchMb: 32,
            cpus: 0.5,
            pids: 32,
            lifetimeSeconds: 180,
            startupSeconds: 60,
            commandSeconds: 10,
          },
        },
      },
    },
  };
  const metadata = join(dir, '.git', 'convoy-verification.json');
  t.after(async () => {
    try {
      await runtimeLifecycle(dir, execution, 'destroy');
    } catch {}
    // Also reap a leaked fixture container on the deliberately failing baseline.
    try {
      const r = JSON.parse(await readFile(metadata, 'utf8'));
      await processRun('/usr/bin/docker', ['rm', '-f', r.container]);
      await processRun('systemctl', ['--user', 'stop', `${r.container}-expiry.timer`]);
      if (r.image) await processRun('/usr/bin/docker', ['image', 'rm', r.image]);
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, execution, metadata };
}

test('runtime reconciles container creation when the client is interrupted before returning its ID', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const controller = new AbortController();
  const spawn = childProcess.spawn;
  const intercept = mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== '/usr/bin/docker' || args[0] !== 'create') return spawn(command, args, options);
    // Real Docker finishes creating the named container; its client remains open.
    const relay = `require('node:child_process').execFile('/usr/bin/docker',process.argv.slice(1),(error,stdout,stderr)=>{process.stderr.write(stderr);if(error)process.exit(1);process.stdout.write(stdout);setTimeout(()=>{},5000);});`;
    const child = spawn(process.execPath, ['-e', relay, ...args], options);
    child.stdout.once('data', () => {
      controller.abort();
      child.kill('SIGKILL');
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareVerificationRuntime(f.dir, f.execution, controller.signal),
      /Runtime operation failed/,
    );
  } finally {
    intercept.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    controller.signal.aborted,
    true,
    'Test must interrupt a completed real Docker create',
  );
  const record = JSON.parse(await readFile(f.metadata, 'utf8'));
  const present = (
    await processRun('/usr/bin/docker', ['ps', '-aq', '--filter', `name=^/${record.container}$`])
  ).output.trim();
  assert.equal(present, '', 'Interrupted creation must reconcile and remove its exact container');
  assert.equal(record.state, 'destroyed');
});

test('immediate command completion waits for launch persistence without weakening foreign lock rejection', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await prepareVerificationRuntime(f.dir, f.execution);
  for (let i = 0; i < 5; i++) {
    let completion;
    const supervisor = {
      start(_command, _args, options) {
        completion = options.onExit({ code: 0 }).then(
          () => null,
          (error) => error,
        );
        return randomUUID();
      },
    };
    await runtimeCommand(f.dir, f.execution, 'true', {}, supervisor);
    assert.equal(await completion, null, 'Fast completion must not collide with its launch lock');
    assert.equal(JSON.parse(await readFile(f.metadata, 'utf8')).activeCommand, null);
  }
  const { mkdir } = await import('node:fs/promises');
  await mkdir(f.metadata + '.lock');
  try {
    await assert.rejects(
      runtimeLifecycle(f.dir, f.execution, 'status'),
      /active or requires reconciliation/,
    );
  } finally {
    await rm(f.metadata + '.lock', { recursive: true });
  }
});

test('unobserved interrupted creation stays uncertain even when the runtime is optional', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  f.execution.grant.runtime.required = false;
  const controller = new AbortController();
  const spawn = childProcess.spawn;
  const intercept = mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== '/usr/bin/docker' || args[0] !== 'create') return spawn(command, args, options);
    // No creation response is available; absence now cannot prove a daemon-side
    // operation will not complete later. Do not downgrade to source-only access.
    const child = spawn(
      process.execPath,
      ['-e', "console.log('pending');setTimeout(()=>{},5000)"],
      options,
    );
    child.stdout.once('data', () => controller.abort());
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareVerificationRuntime(f.dir, f.execution, controller.signal),
      /Runtime operation failed/,
    );
  } finally {
    intercept.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(controller.signal.aborted, true);
  assert.equal(JSON.parse(await readFile(f.metadata, 'utf8')).state, 'uncertain');
  await assert.rejects(
    runtimeLifecycle(f.dir, f.execution, 'destroy'),
    /creation outcome is unproven/,
  );
});

test('configured startup deadline covers a slow create response beyond the generic 30-second process limit', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const spawn = childProcess.spawn;
  const intercept = mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== '/usr/bin/docker' || args[0] !== 'create') return spawn(command, args, options);
    const relay = `require('node:child_process').execFile('/usr/bin/docker',process.argv.slice(1),(error,stdout,stderr)=>{process.stderr.write(stderr);if(error)process.exit(1);setTimeout(()=>process.stdout.write(stdout),31000);});`;
    return spawn(process.execPath, ['-e', relay, ...args], options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await prepareVerificationRuntime(f.dir, f.execution)).state, 'ready');
  } finally {
    intercept.mock.restore();
    syncBuiltinESMExports();
  }
});

test('disposable runtime accepts multiline evidence scripts through its command boundary', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await prepareVerificationRuntime(f.dir, f.execution);
  const content = 'observed queue assignment\n'.repeat(300);
  const supervisor = new CommandSupervisor();
  t.after(() => supervisor.close());
  const started = await runtimeCommand(f.dir, f.execution, `cat > /scratch/evidence.txt <<'EVIDENCE'\n${content}EVIDENCE\nwc -l /scratch/evidence.txt`, {}, supervisor);
  let result;
  let output = '';
  do {
    result = await supervisor.poll(started.commandId, f.dir, { waitMs: 100, cursor: result?.cursor ?? 0 });
    output += result.chunks.map(chunk => chunk.text).join('');
  } while (result.state !== 'exited');
  assert.equal(result.code, 0, result.output);
  assert.match(output, /300 \/scratch\/evidence.txt/);
  await assert.rejects(runtimeCommand(f.dir, f.execution, 'x'.repeat(32001), {}, supervisor), /32001 characters.*32000.*Split/s);
});
