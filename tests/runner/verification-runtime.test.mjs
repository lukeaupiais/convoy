import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  probeVerificationRuntime,
  prepareVerificationRuntime,
  runtimeCommand,
  runtimeTool,
  runtimeLifecycle,
  CommandSupervisor,
  processRun,
} from '../../packages/runner/src/index.mjs';

test('disposable runtime: pinned source, private services, bounded scratch, sealed evidence and denied stale authority', async (t) => {
  if (!process.env.CONVOY_RUNTIME_TEST_IMAGE || !(await probeVerificationRuntime())) {
    assert.notEqual(process.env.CONVOY_REQUIRE_VERIFICATION, '1');
    return t.skip('Explicit immutable runtime test image and eligible Docker/systemd required');
  }
  const dir = await mkdtemp(join(tmpdir(), 'convoy-runtime-test-'));
  const supervisor = new CommandSupervisor();
  let execution;
  t.after(async () => {
    await supervisor.close();
    if (execution)
      try {
        await runtimeLifecycle(dir, execution, 'destroy');
      } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  await processRun('git', ['init', '-q', dir]);
  await writeFile(join(dir, 'README.md'), 'Fixture source\nSecond line\n');
  await writeFile(
    join(dir, 'service.mjs'),
    "import http from 'node:http';http.createServer((req,res)=>res.end('fixture')).listen(8123,'127.0.0.1');\n",
  );
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
  const head = (await processRun('git', ['-C', dir, 'rev-parse', 'HEAD'])).output.trim();
  execution = {
    assignmentToken: randomUUID(),
    policyDigest: 'a'.repeat(64),
    grant: {
      profileId: 'verify',
      runtime: {
        definition: {
          digest: 'b'.repeat(64),
          image: process.env.CONVOY_RUNTIME_TEST_IMAGE,
          sourceCommit: head,
          fixtureDigest: 'c'.repeat(64),
          startup: ['/usr/local/bin/node', '/source/service.mjs'],
          readiness: [
            '/usr/local/bin/node',
            '-e',
            "let n=0;const probe=()=>fetch('http://127.0.0.1:8123').then(r=>r.text()).then(t=>{if(t!=='fixture')process.exit(2);}).catch(()=>{if(++n>50)process.exit(1);setTimeout(probe,50);});probe();",
          ],
          guidance: 'Use the fixture service.',
          limits: {
            memoryMb: 128,
            scratchMb: 32,
            cpus: 0.5,
            pids: 32,
            lifetimeSeconds: 120,
            startupSeconds: 10,
            commandSeconds: 10,
          },
        },
      },
    },
  };
  const runtime = await prepareVerificationRuntime(dir, execution);
  assert.equal(runtime.state, 'ready');
  assert.equal(runtime.readiness.code, 0);
  // Host changes cannot change the application's source image.
  await writeFile(join(dir, 'README.md'), 'Host changed\n');
  const file = await runtimeTool(dir, execution, 'read_file', { path: 'README.md' });
  assert.match(file.text, /Fixture source/);
  await assert.rejects(
    runtimeTool(dir, execution, 'write_file', {
      path: 'README.md',
      content: 'overwrite',
      expectedHash: file.sha256,
    }),
    /Runtime operation failed/,
  );
  const scratch = await runtimeTool(dir, execution, 'write_file', {
    path: 'scratch/result.txt',
    content: 'observed fixture\n',
    expectedHash: '',
  });
  assert.ok(scratch.sha256);
  await assert.rejects(
    runtimeTool(dir, { ...execution, assignmentToken: randomUUID() }, 'read_file', {
      path: 'README.md',
    }),
    /mismatch/,
  );
  // A long investigation's existing receipts must not impose a hidden 24-call cap.
  const metadata = (await processRun('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'convoy-verification.json'])).output.trim();
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  record.receipts = Array.from({length: 24}, (_, i) => ({commandId: `earlier-${i}`, command: 'true', generation: record.generation, startedAt: Date.now()}));
  await writeFile(metadata, JSON.stringify(record));
  const started = await runtimeCommand(
    dir,
    execution,
    'node -e "fetch(\'http://127.0.0.1:8123\').then(r=>r.text()).then(console.log)"',
    { launchId: randomUUID() },
    supervisor,
  );
  let result;
  do {
    result = await supervisor.poll(started.commandId, dir, {
      waitMs: 100,
      cursor: result?.cursor ?? 0,
    });
  } while (result.state !== 'exited');
  assert.equal(result.code, 0);
  assert.equal(result.reason, null);
  await assert.rejects(
    runtimeCommand(dir, execution, 'true', { timeoutMs: 0 }, supervisor),
    /Invalid execution deadline/,
  );
  // A command deadline must reap its process group without ending the service.
  const timed = await runtimeCommand(
    dir,
    execution,
    'sleep 30 & wait',
    { timeoutMs: 300, launchId: randomUUID() },
    supervisor,
  );
  let timedResult;
  do {
    timedResult = await supervisor.poll(timed.commandId, dir, { waitMs: 100 });
  } while (timedResult.state !== 'exited');
  assert.equal(timedResult.reason, null, 'Inner timeout should finish before the host watchdog');
  assert.notEqual(timedResult.code, 0);
  const recovered = await runtimeCommand(
    dir,
    execution,
    `node -e "fetch('http://127.0.0.1:8123').then(r=>r.text()).then(t=>{if(t!=='fixture')process.exit(1)})"`,
    { launchId: randomUUID() },
    supervisor,
  );
  let recoveredResult;
  do {
    recoveredResult = await supervisor.poll(recovered.commandId, dir, { waitMs: 100 });
  } while (recoveredResult.state !== 'exited');
  assert.equal(recoveredResult.code, 0);
  assert.equal(recoveredResult.reason, null);
  const sealed = await runtimeLifecycle(dir, execution, 'seal', [
    { path: 'README.md' },
    { path: 'scratch/result.txt' },
  ]);
  assert.equal(sealed.state, 'sealed');
  assert.match(sealed.files['README.md'].text, /Fixture source/);
  assert.equal(sealed.files['scratch/result.txt'].text, 'observed fixture\n');
  await assert.rejects(runtimeCommand(dir, execution, 'true', {}, supervisor), /not ready/);
  const secondLine = await runtimeTool(dir, execution, 'read_file', {
    path: 'README.md',
    offset: 2,
    limit: 1,
  });
  assert.equal(secondLine.text, 'Second line\n');
  assert.equal(secondLine.startLine, 2);
  const replay = await prepareVerificationRuntime(dir, execution);
  assert.equal(replay.state, 'sealed');
  assert.equal(replay.generation, 1);
  await runtimeLifecycle(dir, execution, 'destroy');
  const fresh = await prepareVerificationRuntime(dir, execution);
  assert.equal(fresh.generation, 2);
  const escaped = await runtimeCommand(
    dir,
    execution,
    `node -e "require('child_process').spawn('/bin/sleep',['20'],{detached:true,stdio:'ignore'}).unref()"`,
    { launchId: randomUUID() },
    supervisor,
  );
  let orphanResult;
  do {
    orphanResult = await supervisor.poll(escaped.commandId, dir, {
      waitMs: 100,
      cursor: orphanResult?.cursor ?? 0,
    });
  } while (orphanResult.state !== 'exited');
  assert.equal(orphanResult.reason, 'cleanup_uncertain');
  await assert.rejects(runtimeLifecycle(dir, execution, 'seal', []), /cannot be sealed/);
  await runtimeLifecycle(dir, execution, 'destroy');
  execution.grant.runtime.definition.readiness = ['/bin/false'];
  execution.grant.runtime.required = true;
  await assert.rejects(prepareVerificationRuntime(dir, execution), /Runtime operation failed/);
  execution.grant.runtime.required = false;
  const unavailable = await prepareVerificationRuntime(dir, execution);
  assert.equal(unavailable.state, 'unavailable');
  const fallback = await runtimeTool(dir, execution, 'read_file', { path: 'README.md' });
  assert.match(fallback.text, /Fixture source/);
  await assert.rejects(runtimeCommand(dir, execution, 'true', {}, supervisor), /not ready/);
  await assert.rejects(
    runtimeTool(dir, execution, 'write_file', {
      path: 'scratch/no',
      content: 'no',
      expectedHash: '',
    }),
    /only pinned source reads/,
  );
  const fallbackEvidence = await runtimeLifecycle(dir, execution, 'seal', [{ path: 'README.md' }]);
  assert.equal(fallbackEvidence.availability, 'unavailable');
  assert.deepEqual(fallbackEvidence.receipts, []);
});
