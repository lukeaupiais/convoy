import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  executeRunner,
  processRun,
  digest,
  CommandSupervisor,
  driveCommand,
} from '../../packages/runner/src/index.mjs';
import { createExecutionPolicy } from '../../apps/daemon/src/modules/execution/index.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'convoy-inspect-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await processRun('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'source.txt'), 'immutable');
  const policy = createExecutionPolicy({
    state: { projects: [], tickets: [] },
    catalog: { ticket: () => undefined, project: () => ({ executionProfile: 'inspect' }) },
  });
  const grant = policy.resolve(
    { id: 's', projectId: 'p', executionProfile: 'inspect' },
    { id: 'runner', environmentId: 'environment' },
  );
  const execution = {
    version: 1,
    grant,
    policyDigest: grant.digest,
    assignmentToken: randomUUID(),
    workspace,
  };
  await executeRunner({
    action: 'bind_execution',
    workspace,
    binding: {
      version: 1,
      profileId: 'inspect',
      assignmentToken: execution.assignmentToken,
      policyDigest: grant.digest,
    },
  });
  const base = { workspace, accessMode: 'contained', executionProfile: 'inspect', execution };
  return { workspace, base };
}

test('inspection rejects omitted/tampered descriptors and direct write/background/terminal paths', async (t) => {
  const { base } = await fixture(t);
  await assert.rejects(
    executeRunner({
      ...base,
      execution: undefined,
      action: 'tool',
      name: 'shell',
      args: { command: 'true' },
    }),
    /descriptor/,
  );
  await assert.rejects(
    executeRunner({
      workspace: base.workspace,
      action: 'tool',
      name: 'shell',
      args: { command: 'true' },
    }),
    /bound assignment/,
  );
  const stale = structuredClone(base);
  stale.execution.assignmentToken = randomUUID();
  await assert.rejects(
    executeRunner({ ...stale, action: 'tool', name: 'shell', args: { command: 'true' } }),
    /bound assignment/,
  );
  const tampered = structuredClone(base);
  tampered.execution.grant.envelope.filesystem.workspace = 'read-write';
  await assert.rejects(
    executeRunner({ ...tampered, action: 'tool', name: 'shell', args: { command: 'true' } }),
    /digest/,
  );
  await assert.rejects(
    executeRunner({
      ...base,
      action: 'command_start',
      command: 'true',
      launchId: randomUUID(),
      lifetime: 'session',
    }),
    /background/,
  );
  await assert.rejects(executeRunner({ ...base, action: 'terminal_start' }), /terminals/);
  await assert.rejects(
    executeRunner({
      ...base,
      action: 'tool',
      name: 'write_file',
      args: { path: 'new.txt', content: 'no' },
    }),
    /mutation/,
  );
  await assert.rejects(
    executeRunner({
      ...base,
      workspace: '/different',
      action: 'tool',
      name: 'shell',
      args: { command: 'true' },
    }),
    /descriptor/,
  );
});

test('inspection enforces filesystem, socket and process isolation through supervised shell', async (t) => {
  const { workspace, base } = await fixture(t);
  const probe = await executeRunner({ action: 'probe', repository: workspace });
  if (!probe.inspection) {
    assert.notEqual(
      process.env.CONVOY_REQUIRE_INSPECTION,
      '1',
      'Required inspection sandbox is unavailable',
    );
    return t.skip('Inspection sandbox unavailable in this environment');
  }
  const supervisor = new CommandSupervisor();
  t.after(() => supervisor.close());
  const shell = (command) =>
    driveCommand((request) => executeRunner(request, undefined, supervisor), {
      ...base,
      action: 'tool',
      name: 'shell',
      args: { command, timeoutMs: 5000 },
    });
  assert.equal((await shell('pwd; ls; sed -n 1p source.txt; git status --short')).code, 0);
  for (const command of [
    'echo changed > source.txt',
    'sed -i s/immutable/changed/ source.txt',
    'git config local.test bad',
    'sh -c "touch child-write"',
    'ln -s /tmp escape',
  ])
    assert.notEqual((await shell(command)).code, 0, command);
  assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'immutable');
  assert.equal((await shell('echo scratch > /tmp/proof; cat /tmp/proof')).output.trim(), 'scratch');
  assert.notEqual((await shell('cat /tmp/proof')).code, 0);
  let connected = false;
  const server = createServer((socket) => {
    connected = true;
    socket.end();
  });
  const socketPath = join(workspace, 'host.sock');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const node = await shell(
    `node -e 'const net=require("node:net"); const s=net.connect("/workspace/host.sock"); s.on("error",()=>process.exit(17));'`,
  );
  assert.equal(node.code, 17, node.output);
  assert.equal(connected, false);
  const internet = await shell(
    `node -e 'require("node:net").connect(80,"1.1.1.1").on("error",()=>process.exit(17))'`,
  );
  assert.equal(internet.code, 17, internet.output);
  const marker = `convoy-inspect-child-${randomUUID()}`;
  const done = await shell(`bash -c 'exec -a ${marker} sleep 60' >/dev/null 2>&1 & echo finished`);
  assert.equal(done.code, 0);
  assert.match(done.output, /finished/);
  for (const pid of (await readdir('/proc')).filter((p) => /^\d+$/.test(p))) {
    let command;
    try {
      command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
    assert.ok(!command.includes(marker), 'Foreground completion must reap sandbox descendants');
  }
  for (const mode of ['timeout', 'cancel']) {
    const marker = `convoy-inspect-${mode}-${randomUUID()}`;
    const result = await driveCommand(
      (request) => executeRunner(request, undefined, supervisor),
      {
        ...base,
        action: 'tool',
        name: 'shell',
        args: {
          command: `bash -c 'echo ready; exec -a ${marker} sleep 60' & wait`,
          timeoutMs: mode === 'timeout' ? 150 : 5000,
        },
      },
      async (update, stop) => {
        if (mode === 'cancel' && update.output.includes('ready')) await stop();
      },
    );
    assert.equal(result.reason, mode === 'timeout' ? 'deadline' : 'cancelled');
    for (const pid of (await readdir('/proc')).filter((p) => /^\d+$/.test(p))) {
      let command;
      try {
        command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      } catch (error) {
        if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) continue;
        throw error;
      }
      assert.ok(!command.includes(marker), `${mode} must reap sandbox descendants`);
    }
  }
  assert.equal(probe.executionDescriptorVersion, 1);
  assert.equal(probe.cli.sed, true);
});
