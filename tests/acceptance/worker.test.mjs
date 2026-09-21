import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { createWorkerDeployment } from '../../apps/daemon/src/adapters/runners/worker-deployment.mjs';
import { createRpc } from '../../packages/runner/src/index.mjs';
import { runAgentLoop } from '../../packages/runner/src/index.mjs';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { processRun } from '../../packages/runner/src/index.mjs';

test('portable workspace worker is reused across turns while a session command stays controllable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-worker-session-command-'));
  const sandbox = await processRun('bwrap', ['--ro-bind', '/', '/', 'true']); if (sandbox.code !== 0) { t.skip('Bubblewrap unavailable'); return; }
  const env = { ...process.env, CONVOY_WORKER_STATE: join(directory, 'journals') }; delete env.NODE_TEST_CONTEXT;
  const runners = createRunners({ idleMs: 20, deployment: { ensure: async () => ({ sha256: 'fixture' }) }, connect: (_artifact, handlers, _signal, disconnected) => {
    const child = spawn(process.execPath, ['apps/worker/src/worker.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const rpc = createRpc(child.stdout, child.stdin, handlers, disconnected);
    return { call: rpc.call, close: () => { rpc.close(); child.stdin.end(); child.kill(); } };
  } });
  t.after(() => runners.close()); const runner = { id: 'remote-session', kind: 'ssh', host: 'fixture' };
  let executor; let stop; let final; let started; const pids = [];
  const common = {
    started: value => pids.push(value.pid), setExecutor: value => { executor = value; }, prepare: async () => {}, message: async () => {}, afterRound: async () => true,
  };
  await runners.runAgent(runner, { maxRounds: 1, workspace: directory }, {
    ...common, generate: async () => ({ content: [{ type: 'toolCall', id: 'server', name: 'start_command', arguments: { command: 'printf remote-ready; sleep 100', yieldMs: 10 } }] }),
    tool: async ({ call }) => { started = await executor(runner, { action: 'tool', workspace: directory, name: call.name, args: call.arguments }, undefined, async (update, control) => { stop = control; if (update.state === 'exited') final = update; }); return { output: started }; },
  });
  assert.equal(started.state, 'running'); assert.equal(runners.backgroundCount(runner.id), 1);
  await runners.runAgent(runner, { maxRounds: 1, workspace: directory }, { ...common, generate: async () => ({ content: [{ type: 'text', text: 'second turn' }] }), tool: async () => ({}) });
  assert.equal(pids.length, 2); assert.equal(pids[0], pids[1]);
  await stop(); for (let i = 0; i < 100 && !final; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(final.reason, 'cancelled'); assert.equal(runners.backgroundCount(runner.id), 0);
});

test('portable worker loss marks a detached command lost without replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-worker-lost-command-'));
  const sandbox = await processRun('bwrap', ['--ro-bind', '/', '/', 'true']); if (sandbox.code !== 0) { t.skip('Bubblewrap unavailable'); return; }
  let child; const env = { ...process.env, CONVOY_WORKER_STATE: join(directory, 'journals') }; delete env.NODE_TEST_CONTEXT;
  const runners = createRunners({ deployment: { ensure: async () => ({ sha256: 'fixture' }) }, connect: (_artifact, handlers, _signal, disconnected) => {
    child = spawn(process.execPath, ['apps/worker/src/worker.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const rpc = createRpc(child.stdout, child.stdin, handlers, disconnected); child.on('exit', () => rpc.close());
    return { call: rpc.call, close: () => { rpc.close(); child.stdin.end(); child.kill(); } };
  } }); t.after(() => runners.close());
  let latest; const runner = { id: 'remote-lost', kind: 'ssh', host: 'fixture' };
  const result = await runners.execute(runner, { action: 'tool', workspace: directory, name: 'start_command', args: { command: 'printf ready; sleep 100', yieldMs: 10 } }, undefined, async update => { latest = update; });
  assert.equal(result.state, 'running'); child.kill('SIGKILL');
  for (let i = 0; i < 100 && latest?.state !== 'lost'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(latest.state, 'lost'); assert.equal(latest.reason, 'worker_disconnected'); assert.equal(runners.backgroundCount(runner.id), 0);
});

test('worker owns multiple model/tool rounds and journals locally, credentials stay in gateway', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-worker-test-'));
  const env = { ...process.env, CONVOY_WORKER_STATE: directory }; delete env.NODE_TEST_CONTEXT;
  const runners = createRunners({ deployment: { ensure: async () => ({ sha256: 'fixture' }) }, connect: (_artifact, handlers) => {
    const child = spawn(process.execPath, ['apps/worker/src/worker.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const rpc = createRpc(child.stdout, child.stdin, handlers);
    return { call: rpc.call, close: () => { rpc.close(); child.stdin.end(); child.kill(); } };
  } });
  t.after(() => runners.close());
  let round = 0; let execute; let identity; const runner = { id: 'remote-test', kind: 'ssh', host: 'fixture' };
  const outputs = [];
  await runners.runAgent(runner, { maxRounds: 3, workspace: directory }, {
    started: value => { identity = value; },
    setExecutor: value => { execute = value; },
    prepare: async () => { round++; /* private gateway token is never returned */ },
    generate: async () => ({ content: round === 1 ? [{ type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'proof', content: 'remote', expectedHash: '' } }] : [{ type: 'text', text: 'done' }] }),
    message: async () => {},
    tool: async ({ call }) => { const output = await execute(runner, { action: 'tool', workspace: directory, name: call.name, args: call.arguments }); outputs.push(output); return { output }; },
    afterRound: async ({ hasCalls }) => !hasCalls,
  }, new AbortController().signal);
  assert.notEqual(identity.pid, process.pid); assert.equal(round, 2); assert.equal(outputs.length, 1);
  assert.equal(await readFile(join(directory, 'proof'), 'utf8'), 'remote');
  const journalPath = (await readdir(directory)).find(file => file.endsWith('.jsonl'));
  const journal = (await readFile(join(directory, journalPath), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).type, 'completed');
  assert.ok(journal.some(e => e.type === 'operation_finished'));
});

test('agent loop bounds rounds and never requests another model after accepted submission', async () => {
  let calls = 0;
  await runAgentLoop({ maxRounds: 2 }, async method => {
    if (method === 'generate') { calls++; return { content: [{ type: 'toolCall', name: 'submit_step' }] }; }
    if (method === 'tool') return { submitted: true };
    if (method === 'afterRound') return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(runAgentLoop({ maxRounds: 1 }, async method => method === 'generate' ? { content: [] } : false), /limit reached/);
});

test('deployment validates artifacts before upload and reuses checksum-addressed releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-deploy-test-'));
  const bytes = Buffer.from('fixture-worker'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'convoy-worker-linux-x64'), bytes);
  await writeFile(join(directory, 'linux-x64.json'), JSON.stringify({ protocol: 1, platform: 'linux-x64', sha256 }));
  const requests = [];
  const deployment = createWorkerDeployment({ directory, transport: async (command, args, options) => {
    requests.push({ command, args, options }); return { code: 0, output: args.at(-1) === 'uname -sm' ? 'Linux x86_64\n' : 'cached' };
  } });
  const result = await deployment.ensure('fixture');
  assert.equal(result.reused, true); assert.equal(requests.length, 2);
  assert.equal(requests.some(r => r.options.input), false);
  await writeFile(join(directory, 'convoy-worker-linux-x64'), 'tampered');
  await assert.rejects(deployment.ensure('fixture'), /checksum/);
  assert.equal(requests.length, 3);
  await assert.rejects(deployment.ensure('host;bad'), /Invalid SSH/);
});

test('disconnect rejects pending calls without replay', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(); const output = new PassThrough();
  let sent = 0; output.on('data', () => sent++);
  const rpc = createRpc(input, output);
  const pending = rpc.call('execute', { name: 'write_file' });
  const rejected = assert.rejects(pending, /disconnected/);
  input.end(); await rejected; assert.equal(sent, 1);
});

test('disconnect during approval settles once, does not write, and retains context for explicit resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-worker-disconnect-'));
  const repository = join(directory, 'repository');
  assert.equal((await processRun('git', ['init', repository])).code, 0);
  assert.equal((await processRun('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: repository })).code, 0);
  let disconnect;
  const env = { ...process.env, CONVOY_WORKER_STATE: join(directory, 'journals') }; delete env.NODE_TEST_CONTEXT;
  const runners = createRunners({ deployment: { ensure: async () => ({ sha256: 'fixture' }) }, connect: (_artifact, handlers) => {
    const child = spawn(process.execPath, ['apps/worker/src/worker.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const rpc = createRpc(child.stdout, child.stdin, handlers);
    const close = () => { rpc.close(); child.stdin.end(); child.kill(); };
    if (handlers.tool) disconnect = close;
    return { call: rpc.call, close };
  } });
  let generations = 0;
  const runtime = await createRuntime({ directory: join(directory, 'coordinator'), runners, models: [{ id: 'fixture' }], auth: { token: async () => 'private', status: async () => ({ connected: true }) }, generate: async function* () {
    generations++;
    yield { type: 'result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'one', name: 'write_file', arguments: { path: 'must-not-exist', content: 'unsafe', expectedHash: '' } }], stopReason: 'toolUse' } };
  } });
  t.after(() => runtime.close());
  const act = (action, input = {}) => runtime.command({ action, client: 'disconnect-test', ...input });
  await act('connectRemote', { host: 'fixture', repository, projectIds: ['agent-platform'] });
  const runner = (await runtime.snapshot()).runners[0];
  const conversation = await act('createConversation', { requestId: 'disconnect-chat', projectId: 'agent-platform', placement: { mode: 'pinned', runnerId: runner.id } });
  const sessionId = conversation.sessionId;
  await act('claim', { sessionId });
  await act('start', { sessionId, model: 'fixture', requestId: 'disconnect-turn', text: 'Keep my context' });
  const current = async () => (await runtime.snapshot()).sessions.find(s => s.id === sessionId);
  async function until(check) { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Test timed out'); }
  await until(async () => (await current()).pending);
  disconnect();
  await until(async () => !(await current()).control.busy);
  const session = await current();
  assert.equal(session.status, 'interrupted'); assert.equal(session.pending, null); assert.equal(generations, 1);
  assert.equal(session.events.filter(e => e.type === 'tool_result' && e.callId === 'one').length, 1);
  assert.ok(session.events.some(e => e.type === 'user' && e.text === 'Keep my context'));
  await assert.rejects(readFile(join(session.workspace.path, 'must-not-exist')), { code: 'ENOENT' });
});
