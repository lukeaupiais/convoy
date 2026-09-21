// Explicit opt-in integration check. Creates only isolated /tmp repositories on
// the named hosts and local temp coordinator state; never touches the live app.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createAuth } from '../apps/daemon/src/adapters/auth/auth.mjs';
import { createRunners } from '../apps/daemon/src/adapters/runners/runners.mjs';
import { digest, processRun, sshArgs } from '../packages/runner/src/index.mjs';

const live = process.argv.includes('--live');
const hosts = process.argv.slice(2).filter((value) => value !== '--live');
const provider = live ? await import('../apps/daemon/src/adapters/providers/provider.mjs') : null;
const liveAuth = live ? await createAuth(new URL('../.convoy', import.meta.url).pathname) : null;
const liveModel =
  provider?.models.find((m) => m.id === 'gpt-5.6-sol')?.id ?? provider?.models[0]?.id;
if (!hosts.length)
  throw new Error(
    'Pass explicit SSH test hosts, e.g. node scripts/test-remote-worker.mjs host-a host-b',
  );
const reply = (content) => ({
  role: 'assistant',
  content,
  stopReason: 'stop',
  timestamp: Date.now(),
});
async function until(check) {
  for (let i = 0; i < 600; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for remote session.');
}
for (const host of hosts) {
  const setup = await processRun(
    'ssh',
    [
      ...(await sshArgs(host)),
      'set -eu; fixture=$(mktemp -d /tmp/convoy-worker-smoke.XXXXXXXX); git init -q "$fixture"; git -C "$fixture" -c user.name=Convoy-Test -c user.email=test@example.invalid -c core.hooksPath=/dev/null commit -q --allow-empty -m fixture; printf "%s" "$fixture"',
    ],
    { timeout: 15000 },
  );
  assert.equal(setup.code, 0);
  const repository = setup.output.trim();
  assert.match(repository, /^\/tmp\/convoy-worker-smoke\.[a-zA-Z0-9]+$/);
  const runners = createRunners();
  let round = 0;
  let streamed = false;
  let liveMode = false;
  const directory = await mkdtemp(join(tmpdir(), 'convoy-remote-coordinator-'));
  const runtime = await createRuntime({
    directory,
    runners,
    provider: provider?.provider,
    models: [{ id: 'fixture-model' }, ...(provider?.models ?? [])],
    auth: {
      token: async (signal) =>
        liveMode ? liveAuth.token(signal) : 'fixture-secret-never-transferred',
      status: async () => ({ connected: true }),
    },
    generate: async function* (input) {
      if (liveMode) {
        yield* provider.generate(input);
        return;
      }
      const { messages } = input;
      round++;
      yield { type: 'delta', text: 'Remote verification…' };
      if (round === 1)
        yield {
          type: 'result',
          message: reply([
            {
              type: 'toolCall',
              id: 'write-1',
              name: 'write_file',
              arguments: {
                path: 'worker-proof.txt',
                content: `Executed on ${host}\n`,
                expectedHash: '',
              },
            },
          ]),
        };
      else if (round === 2)
        yield {
          type: 'result',
          message: reply([
            {
              type: 'toolCall',
              id: 'read-1',
              name: 'read_file',
              arguments: { path: 'worker-proof.txt' },
            },
          ]),
        };
      else if (round === 3)
        yield {
          type: 'result',
          message: reply([
            {
              type: 'toolCall',
              id: 'patch-1',
              name: 'apply_patch',
              arguments: {
                path: 'worker-proof.txt',
                expectedHash: digest(`Executed on ${host}\n`),
                edits: [{ oldText: 'Executed', newText: 'Patched' }],
              },
            },
          ]),
        };
      else if (round === 4)
        yield {
          type: 'result',
          message: reply([
            {
              type: 'toolCall',
              id: 'read-2',
              name: 'read_file',
              arguments: { path: 'worker-proof.txt' },
            },
          ]),
        };
      else {
        assert.ok(JSON.stringify(messages).includes(`Patched on ${host}`));
        yield {
          type: 'result',
          message: reply([{ type: 'text', text: 'Remote write, atomic patch and read verified.' }]),
        };
      }
    },
  });
  runtime.subscribe((change) => {
    if (change.type === 'partial' && change.text) streamed = true;
  });
  const act = (action, input = {}) =>
    runtime.command({ action, client: 'remote-smoke-client', ...input });
  try {
    await act('connectRemote', { host, repository, projectIds: ['agent-platform'] });
    const runner = (await runtime.snapshot()).runners[0];
    assert.equal(runner.capabilities.worker.execution, 'worker');
    assert.ok(runner.capabilities.worker.capabilities.includes('atomic-patch-v1'));
    const conversation = await act('createConversation', {
      requestId: 'remote-proof',
      projectId: 'agent-platform',
      placement: { mode: 'pinned', runnerId: runner.id },
    });
    const sessionId = conversation.sessionId;
    const session = async () => (await runtime.snapshot()).sessions.find((s) => s.id === sessionId);
    await act('claim', { sessionId });
    await act('start', {
      sessionId,
      model: 'fixture-model',
      text: 'Run isolated remote verification.',
      requestId: 'remote-proof-turn',
    });
    let pending = await until(async () => {
      const s = await session();
      if (s.status === 'failed') throw new Error(JSON.stringify(s.events.slice(-3)));
      return s.pending;
    });
    assert.equal(pending.tool, 'write_file');
    await assert.rejects(
      runners.execute(runner, {
        action: 'tool',
        workspace: (await session()).workspace.path,
        name: 'read_file',
        args: { path: 'worker-proof.txt' },
      }),
    );
    await act('decide', { sessionId, approvalId: pending.id, decision: 'allow_once' });
    pending = await until(async () => {
      const value = (await session()).pending;
      return value?.tool === 'apply_patch' ? value : null;
    });
    await act('decide', { sessionId, approvalId: pending.id, decision: 'allow_once' });
    await until(async () => !(await session()).control.busy);
    const s = await session();
    assert.equal(s.status, 'awaiting_review', JSON.stringify(s.events.slice(-4)));
    assert.ok(streamed);
    assert.equal(s.events.filter((e) => e.type === 'tool_result' && !e.isError).length, 4);
    assert.equal(s.events.find((e) => e.type === 'worker_started').hostname, host);
    const readback = await runners.execute(runner, {
      action: 'tool',
      workspace: s.workspace.path,
      name: 'read_file',
      args: { path: 'worker-proof.txt' },
    });
    assert.equal(readback.text, `Patched on ${host}\n`);
    const listed = await runners.execute(runner, {
      action: 'tool',
      workspace: s.workspace.path,
      name: 'list_files',
      args: { glob: '**/*.txt' },
    });
    assert.ok(listed.paths.includes('worker-proof.txt'));
    const searched = await runners.execute(runner, {
      action: 'tool',
      workspace: s.workspace.path,
      name: 'search_files',
      args: { query: '^Patched\\s+on', regex: true },
    });
    assert.equal(searched.hits[0].path, 'worker-proof.txt');
    const gitStatus = await runners.execute(runner, {
      action: 'tool',
      workspace: s.workspace.path,
      name: 'inspect_repository',
      args: { operation: 'status' },
    });
    assert.match(gitStatus.output, /worker-proof\.txt/);

    if (runner.capabilities.shell) {
      let commandUpdate;
      const command = await runners.execute(
        runner,
        {
          action: 'tool',
          workspace: s.workspace.path,
          name: 'start_command',
          args: { command: 'IFS= read -r line; printf "stdin:%s" "$line"', yieldMs: 50 },
        },
        undefined,
        async (update) => {
          commandUpdate = update;
        },
      );
      assert.equal(command.state, 'running', JSON.stringify(command));
      await runners.execute(runner, {
        action: 'command_input',
        workspace: s.workspace.path,
        commandId: command.commandId,
        input: 'ship\n',
        close: true,
      });
      await until(() => (commandUpdate?.state === 'exited' ? commandUpdate : null));
      assert.equal(commandUpdate.code, 0);
      assert.match(commandUpdate.output, /stdin:ship/);
    } else {
      assert.ok(!runner.capabilities.tools.includes('start_command'));
      assert.ok(!runner.capabilities.tools.includes('send_command_input'));
    }
    console.log(
      JSON.stringify({
        host,
        status: 'passed',
        provider: 'deterministic fixture, not live model',
        streamed,
        shell: runner.capabilities.shell,
        worker: s.events.find((e) => e.type === 'worker_started'),
        repository,
        workspace: s.workspace.path,
        coordinatorState: directory,
      }),
    );
    if (live) {
      // Opt-in live subscription check: only a read of the test-owned proof file
      // can be approved. No remote credentials, installs or production access.
      await liveAuth.token();
      liveMode = true;
      streamed = false;
      // Use a fresh conversation: synthetic provider messages deliberately lack
      // provider-specific response metadata and are not a valid live transcript.
      const liveChat = await act('createConversation', {
        requestId: 'live-proof-chat',
        projectId: 'agent-platform',
        placement: { mode: 'pinned', runnerId: runner.id },
      });
      const liveId = liveChat.sessionId;
      const liveSession = async () =>
        (await runtime.snapshot()).sessions.find((s) => s.id === liveId);
      await act('claim', { sessionId: liveId });
      await act('configure', { sessionId: liveId, runnerId: runner.id });
      await runners.execute(runner, {
        action: 'tool',
        workspace: (await liveSession()).workspace.path,
        name: 'write_file',
        args: { path: 'worker-proof.txt', content: `Executed on ${host}\n`, expectedHash: '' },
      });
      await act('start', {
        sessionId: liveId,
        model: liveModel,
        requestId: 'live-proof-turn',
        text: 'Read worker-proof.txt using read_file and report its exact contents. Do not modify any files, run commands, or create tickets.',
      });
      await until(async () => {
        const current = await liveSession();
        if (current.pending) {
          const allow =
            current.pending.tool === 'read_file' &&
            current.pending.args.path === 'worker-proof.txt';
          await act('decide', { sessionId: liveId, approvalId: current.pending.id, allow });
        }
        return !current.control.busy;
      });
      const current = await liveSession();
      const events = current.events;
      assert.equal(current.status, 'awaiting_review', JSON.stringify(events.slice(-3)));
      assert.ok(
        events.some((e) => e.type === 'tool_result' && e.tool === 'read_file' && !e.isError),
      );
      assert.ok(
        events.some((e) => e.type === 'assistant' && e.text.includes(`Executed on ${host}`)),
      );
      assert.ok(streamed);
      console.log(
        JSON.stringify({
          host,
          liveModel,
          status: 'live-provider-passed',
          streamed,
          sessionId: liveId,
          workspace: current.workspace.path,
        }),
      );
    }
  } finally {
    await runtime.close();
  }
}
liveAuth?.close();
