import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createCapabilities } from '../../apps/daemon/src/modules/library/index.mjs';
import {
  createExecutionPolicy,
  createSessionExecution,
} from '../../apps/daemon/src/modules/execution/index.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { createWorkerDeployment } from '../../apps/daemon/src/adapters/runners/worker-deployment.mjs';
import { connectWorker } from '../../apps/daemon/src/adapters/runners/worker-client.mjs';
import {
  createRpc,
  deepThoughtExtensionManifest,
  processRun,
  sshArgs,
} from '../../packages/runner/src/index.mjs';

const enabled = process.env.CONVOY_TEST_DEEPTHOUGHT_SSH === '1';

test(
  'DeepThought through authenticated SSH, deployed worker and granted session',
  { skip: !enabled },
  async (t) => {
    const python = process.env.CONVOY_TEST_DEEPTHOUGHT_PYTHON;
    const binary = process.env.CONVOY_TEST_COMPILED_WORKER;
    assert(python && binary, 'SSH opt-in requires the real SDK and compiled worker');
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-ssh-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const previousConfig = process.env.CONVOY_SSH_CONFIG;
    let daemon;
    let runners;
    const clients = new Set();
    t.after(async () => {
      for (const client of clients) client.close();
      await runners?.close();
      if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
        const closed = once(daemon, 'close');
        process.kill(-daemon.pid, 'SIGKILL');
        await closed;
      }
      if (previousConfig === undefined) delete process.env.CONVOY_SSH_CONFIG;
      else process.env.CONVOY_SSH_CONFIG = previousConfig;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(home);
    await mkdir(workspace);
    for (const name of ['host', 'client']) {
      const key = await processRun(
        'ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)],
        { timeout: 5000 },
      );
      assert.equal(key.code, 0, key.output);
    }
    const reservation = createServer();
    await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const knownHosts = join(root, 'known_hosts');
    await writeFile(
      knownHosts,
      `[127.0.0.1]:${port} ${(await readFile(join(root, 'host.pub'), 'utf8')).trim()}\n`,
    );
    const config = join(root, 'ssh_config');
    await writeFile(
      config,
      `Host deepthought-fixture\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${join(root, 'client')}\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n LogLevel ERROR\n`,
    );
    process.env.CONVOY_SSH_CONFIG = config;
    // sshd otherwise rejects the /tmp ancestor; mkdtemp keeps the fixture private.
    const serverConfig = join(root, 'sshd_config');
    await writeFile(
      serverConfig,
      `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${join(root, 'host')}\nPidFile ${join(root, 'sshd.pid')}\nAuthorizedKeysFile ${join(root, 'client.pub')}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nDisableForwarding yes\nPermitUserEnvironment no\nSetEnv HOME=${home} CONVOY_DEEPTHOUGHT_PYTHON=${python}\nLogLevel ERROR\n`,
    );
    let serverError = '';
    daemon = spawn(
      process.env.CONVOY_TEST_SSHD ?? '/usr/sbin/sshd',
      ['-D', '-e', '-f', serverConfig],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    daemon.on('error', (error) => {
      serverError += error.message;
    });
    daemon.stderr.on('data', (data) => {
      serverError = (serverError + data).slice(-4000);
    });
    const args = await sshArgs('deepthought-fixture');
    for (let attempt = 0; ; attempt++) {
      const ready = await processRun('ssh', [...args, 'printf "%s" "$HOME"'], { timeout: 3000 });
      if (ready.code === 0) {
        assert.equal(ready.output, home, 'SSH storage must remain inside the disposable home');
        break;
      }
      assert(attempt < 20, `SSH fixture unavailable: ${serverError} ${ready.output}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    await t.test('unknown host key is rejected', async () => {
      const unknown = await processRun(
        'ssh',
        ['-o', 'UserKnownHostsFile=/dev/null', ...args, 'true'],
        { timeout: 5000 },
      );
      assert.notEqual(unknown.code, 0);
      assert.match(unknown.output, /Host key verification failed/);
    });
    const deployment = createWorkerDeployment({ directory: dirname(resolve(binary)) });
    const artifact = await deployment.ensure('deepthought-fixture');
    assert.equal(artifact.reused, false);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    const uploaded = await readFile(join(home, '.local/share/convoy/workers', artifact.sha256));
    assert.deepEqual(
      uploaded,
      await readFile(binary),
      'Production deployment must upload exactly the compiled artifact',
    );
    assert.equal((await deployment.ensure('deepthought-fixture')).reused, true);
    assert.equal((await processRun('git', ['init', '-q', workspace])).code, 0);
    await writeFile(join(workspace, 'source.py'), 'class Before: pass\n');
    await copyFile('tests/support/deepthought/typescript.scip', join(workspace, 'index.scip'));
    runners = createRunners({ deployment });
    const runner = {
      id: 'ssh',
      kind: 'ssh',
      host: 'deepthought-fixture',
      environmentId: 'environment',
      accessMode: 'contained',
    };
    runner.capabilities = await runners.execute(runner, { action: 'probe', repository: workspace });
    assert.equal(runner.capabilities.inspection, true, runner.capabilities.inspectionReason);
    assert.deepEqual(runner.capabilities.extensionAdapters, ['deepthought']);
    assert.equal(runner.capabilities.worker.sha256, artifact.sha256);
    const capabilities = createCapabilities({
      state: { projects: [{ id: 'project' }], sessions: {}, runners: [runner] },
    });
    const published = capabilities.command({
      action: 'publishExtension',
      manifest: deepThoughtExtensionManifest,
      trusted: true,
    });
    const profile = capabilities.command({
      action: 'publishProfile',
      id: 'intelligence',
      name: 'Intelligence',
      tools: [],
      skills: [],
      extensions: [{ id: published.id, revision: published.revision, hash: published.hash }],
    });
    const session = {
      id: 'session',
      projectId: 'project',
      executionProfile: 'inspect',
      runnerId: runner.id,
      workspace: { path: workspace },
    };
    capabilities.pin(session, profile);
    const policy = createExecutionPolicy({
      state: { projects: [] },
      catalog: { ticket: () => undefined, project: () => ({ executionProfile: 'inspect' }) },
    });
    const grant = policy.resolve(session, runner);
    session.executionGrant = grant;
    session.assignment = { token: randomUUID(), policyDigest: grant.digest };
    await runners.execute(runner, {
      action: 'bind_execution',
      workspace,
      binding: {
        version: 1,
        profileId: 'inspect',
        assignmentToken: session.assignment.token,
        policyDigest: grant.digest,
      },
    });
    const execution = createSessionExecution({
      runners,
      runnerFor: () => runner,
      executionPolicy: policy,
      extensionTool: (s, name) => capabilities.extensionTool(s, null, name),
    });
    const query = (args = { operation: 'definitions' }) =>
      execution.tool(session, 'code_intelligence', args);
    await t.test(
      'remote queries retain engine version, snapshot evidence and source edits',
      async () => {
        const before = await query();
        assert.equal(before.matches[0].definition.symbol, 'Before');
        await writeFile(join(workspace, 'source.py'), 'class After: pass\n');
        const after = await query();
        assert.equal(after.matches[0].definition.symbol, 'After');
        assert.notEqual(after.snapshot_id, before.snapshot_id);
        for (const result of [before, after]) {
          assert.equal(result.engine_version, '0.2.4a1');
          assert.equal(result.source_consistency.snapshot_id, result.snapshot_id);
          assert.equal(result.source_consistency.scope, 'recorded_files');
          assert.equal(result.source_consistency.status, 'unchanged');
          assert.equal(result.workspace_freshness, 'unverified');
          assert(Buffer.byteLength(JSON.stringify(result)) + 1 <= 32000);
        }
        const indexed = await query({
          operation: 'references',
          index: 'index.scip',
          symbol:
            'scip-typescript npm deepthought-typescript-fixture 0.0.0 other/`helpers.ts`/helper().',
        });
        assert.equal(indexed.total_matches, 3);
        assert.equal(indexed.status, 'partial');
        assert.equal(indexed.source_consistency.status, 'unverified');
        assert(
          indexed.source_consistency.checks.every((check) => check.reason === 'no_source_digest'),
        );
        assert.equal(indexed.workspace_freshness, 'unverified');
      },
    );
    await t.test('assignment mismatch and unreviewed revision fail over SSH', async () => {
      const request = {
        action: 'extension',
        workspace,
        adapter: 'deepthought',
        extension: { id: published.id, revision: published.revision, hash: published.hash },
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions' },
      };
      await assert.rejects(runners.execute(runner, request), /bound assignment/);
      const execution = {
        version: 1,
        workspace,
        assignmentToken: session.assignment.token,
        policyDigest: grant.digest,
        grant,
      };
      await assert.rejects(
        runners.execute(runner, {
          ...request,
          execution: { ...execution, assignmentToken: randomUUID() },
        }),
        /bound assignment/,
      );
      await assert.rejects(
        runners.execute(runner, {
          ...request,
          execution,
          extension: { ...request.extension, hash: '0'.repeat(64) },
        }),
        /revision or tool/,
      );
    });
    await t.test('worker exits naturally when SSH stdin reaches EOF', async () => {
      const child = spawn('ssh', [...artifact.args, artifact.command], {
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.resume();
      const rpc = createRpc(child.stdout, child.stdin);
      t.after(() => {
        rpc.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      const hello = await rpc.call('hello');
      const result = await rpc.call('execute', {
        action: 'extension',
        operationId: randomUUID(),
        workspace,
        adapter: 'deepthought',
        extension: { id: published.id, revision: published.revision, hash: published.hash },
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions' },
        execution: {
          version: 1,
          workspace,
          assignmentToken: session.assignment.token,
          policyDigest: grant.digest,
          grant,
        },
      });
      assert.equal(result.matches[0].definition.symbol, 'After');
      const exited = once(child, 'close', { signal: AbortSignal.timeout(5000) });
      child.stdin.end();
      assert.deepEqual(await exited, [0, null], 'EOF must allow a clean SSH/worker exit');
      assert.throws(() => process.kill(hello.pid, 0), { code: 'ESRCH' });
      rpc.close();
    });
    await t.test('unprovisioned remote runtime is not advertised and rejects queries', async () => {
      const client = connectWorker({
        ...artifact,
        command: `unset CONVOY_DEEPTHOUGHT_PYTHON; ${artifact.command}`,
      });
      clients.add(client);
      const hello = await client.call('hello');
      const probe = await client.call('execute', {
        action: 'probe',
        repository: workspace,
        operationId: randomUUID(),
      });
      assert.deepEqual(probe.extensionAdapters, []);
      await assert.rejects(
        client.call('execute', {
          action: 'extension',
          operationId: randomUUID(),
          workspace,
          adapter: 'deepthought',
          extension: { id: published.id, revision: published.revision, hash: published.hash },
          tool: 'extension.deepthought.query',
          args: { operation: 'definitions' },
          execution: {
            version: 1,
            workspace,
            assignmentToken: session.assignment.token,
            policyDigest: grant.digest,
            grant,
          },
        }),
        /not installed/,
      );
      client.close();
      clients.delete(client);
      for (let attempt = 0; ; attempt++) {
        try {
          process.kill(hello.pid, 0);
        } catch (error) {
          assert.equal(error.code, 'ESRCH');
          break;
        }
        assert(attempt < 50, 'Remote worker must exit when its SSH channel closes');
        await new Promise((done) => setTimeout(done, 50));
      }
    });
  },
);
