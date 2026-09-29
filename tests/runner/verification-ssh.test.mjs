import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { processRun, createRpc } from '../../packages/runner/src/index.mjs';
import { createExecutionPolicy } from '../../apps/daemon/src/modules/execution/index.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
test('compiled SSH worker: runtime capture and independent expiry after disconnect', async (t) => {
  if (process.env.CONVOY_RUNTIME_SSH !== '1')
    return t.skip('Explicit loopback SSH/runtime test opt-in required');
  const root = await mkdtemp(join(tmpdir(), 'convoy-ssh-verify-'));
  let daemon;
  let runners;
  let stderr = '';
  try {
    for (const name of ['host', 'client'])
      assert.equal(
        (await processRun('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]))
          .code,
        0,
      );
    const reserve = createServer();
    await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const config = join(root, 'sshd_config');
    await writeFile(
      config,
      `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${join(root, 'host')}\nPidFile ${join(root, 'pid')}\nAuthorizedKeysFile ${join(root, 'client.pub')}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
    );
    daemon = spawn('/usr/bin/sshd', ['-D', '-e', '-f', config], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    daemon.stderr.on('data', (b) => (stderr += b));
    const args = [
      '-F',
      '/dev/null',
      '-p',
      String(port),
      '-i',
      join(root, 'client'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=2',
      `${userInfo().username}@127.0.0.1`,
    ];
    for (let n = 0; n < 30; n++) {
      const r = await processRun('ssh', [...args, 'true'], { timeout: 3000 });
      if (r.code === 0) break;
      if (n === 29) throw new Error('Loopback SSH unavailable: ' + stderr + ' ' + r.output);
      await new Promise((r) => setTimeout(r, 50));
    }
    const repo = join(root, 'repo');
    await mkdir(repo);
    await processRun('git', ['init', '-q', repo]);
    await processRun('git', [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ]);
    await writeFile(join(repo, 'AGENTS.md'), 'SSH local guidance');
    const command = fileURLToPath(
      new URL('../../dist-worker/convoy-worker-linux-x64', import.meta.url),
    );
    runners = createRunners({
      deployment: { ensure: async () => ({ args, command, sha256: 'local-test-artifact' }) },
    });
    const runner = {
      id: 'loopback',
      kind: 'ssh',
      host: 'loopback-fixture',
      accessMode: 'contained',
    };
    const probe = await runners.execute(runner, { action: 'probe', repository: repo });
    assert.equal(probe.inspection, true, probe.inspectionReason);
    const workspace = await runners.execute(runner, {
      action: 'provision',
      repository: repo,
      workspaceId: 'inspection',
      loadWorkspaceAgentsMd: true,
    });
    assert.equal(workspace.guidanceBootstrap.kind, 'seeded');
    const policy = createExecutionPolicy({
      state: { projects: [] },
      catalog: { ticket: () => undefined, project: () => ({ executionProfile: 'verify' }) },
    });
    const head = (
      await processRun('git', ['-C', workspace.path, 'rev-parse', 'HEAD'])
    ).output.trim();
    const definition = {
      digest: 'a'.repeat(64),
      sourceCommit: head,
      image: process.env.CONVOY_RUNTIME_TEST_IMAGE,
      fixtureDigest: 'b'.repeat(64),
      guidance: 'SSH fixture',
      startup: [],
      readiness: ['/bin/true'],
      limits: {
        memoryMb: 128,
        scratchMb: 32,
        cpus: 0.5,
        pids: 32,
        lifetimeSeconds: 30,
        startupSeconds: 10,
        commandSeconds: 10,
      },
    };
    const grant = policy.resolve(
      { id: 's', projectId: 'p', runtimeSelection: { definition, required: true } },
      runner,
    );
    const assignmentToken = randomUUID();
    await runners.execute(runner, {
      action: 'bind_execution',
      workspace: workspace.path,
      binding: { version: 1, profileId: 'verify', policyDigest: grant.digest, assignmentToken },
    });
    const base = {
      workspace: workspace.path,
      execution: {
        version: 1,
        workspace: workspace.path,
        assignmentToken,
        policyDigest: grant.digest,
        grant,
      },
    };
    assert.equal(probe.verification, true);
    const ready = await runners.execute(runner, {
      ...base,
      action: 'verification',
      operation: 'prepare',
    });
    assert.equal(ready.state, 'ready');
    const success = await runners.execute(runner, {
      ...base,
      action: 'tool',
      name: 'shell',
      args: { command: 'printf ssh-observation > /scratch/result.txt; cat /scratch/result.txt' },
    });
    assert.equal(success.code, 0, success.output);
    const sealed = await runners.execute(runner, {
      ...base,
      action: 'verification',
      operation: 'seal',
      files: [{ path: 'scratch/result.txt' }],
    });
    assert.equal(sealed.files['scratch/result.txt'].text, 'ssh-observation');
    await assert.rejects(
      runners.execute(runner, {
        action: 'tool',
        workspace: workspace.path,
        name: 'shell',
        args: { command: 'true' },
      }),
      /bound assignment/,
    );
    await runners.execute(runner, { ...base, action: 'verification', operation: 'destroy' });
    const expiring = await runners.execute(runner, {
      ...base,
      action: 'verification',
      operation: 'prepare',
    });
    await runners.close();
    runners = null;
    const name = `convoy-verification-${expiring.id}`;
    assert.equal((await processRun('docker', ['inspect', name])).code, 0);
    let gone = false;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await processRun('docker', ['inspect', name])).code !== 0) {
        gone = true;
        break;
      }
    }
    assert.equal(
      gone,
      true,
      'Independent watchdog must remove runtime after SSH worker disconnect',
    );
  } finally {
    await runners?.close();
    if (daemon) {
      daemon.kill();
      await new Promise((r) => daemon.once('close', r));
    }
    await rm(root, { recursive: true, force: true });
  }
});
