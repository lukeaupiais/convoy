import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
const credential = { token: async () => 'test-token', status: async () => ({ connected: true }) };
const assistant = (content) => ({
  role: 'assistant',
  content,
  timestamp: Date.now(),
  stopReason: 'stop',
});

test('native workspace terminals are session-owned, reconnectable and explicitly stopped', async (t) => {
  const terminalId = 'cccccccc-dddd-eeee-ffff-000000000000';
  let state = 'running';
  let starts = 0;
  const descriptor = {
    transport: 'tmux',
    socket: '/tmp/convoy-terminals-fixture/tmux.sock',
    target: `convoy-${terminalId}`,
    kind: 'local',
  };
  const runners = {
    execute: async (_runner, request) => {
      if (request.action === 'probe')
        return { repository: '/fixture', tools: ['read_file'], shell: true, terminal: true };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'test' };
      if (request.action === 'terminal_start') {
        starts++;
        return {
          terminalId,
          state,
          startedAt: Date.now(),
          attached: 0,
          retainedBytes: 0,
          connection: descriptor,
        };
      }
      if (request.action === 'terminal_status')
        return {
          terminalId,
          state,
          startedAt: Date.now(),
          attached: 0,
          retainedBytes: 0,
          connection: descriptor,
        };
      if (request.action === 'terminal_stop') {
        state = 'exited';
        return {
          terminalId,
          state,
          reason: 'cancelled',
          startedAt: Date.now(),
          endedAt: Date.now(),
          connection: descriptor,
        };
      }
      if (request.action === 'terminal_read')
        return { text: 'workspace shell', cursor: 15, hasMore: false };
      if (request.action === 'diff') return { digest: 'unchanged' };
      throw new Error(`Unexpected ${request.action}`);
    },
    close: async () => {},
  };
  const f = await fixture(async function* () {
    yield { type: 'result', message: assistant([{ type: 'text', text: 'ready' }]) };
  }, runners);
  t.after(() => f.runtime.close());
  await f.act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  await f.act('configure', { runnerId: (await f.runtime.snapshot()).runners[0].id });
  await f.act('start', {
    text: 'Prepare workspace',
    model: 'test-model',
    requestId: 'terminal-workspace',
  });
  await until(async () => (await f.session()).status === 'awaiting_review');
  const opened = await f.act('openTerminal');
  assert.equal(opened.connection.target, descriptor.target);
  assert.equal(starts, 1);
  const reopened = await f.act('openTerminal');
  assert.equal(reopened.terminalId, terminalId);
  assert.equal(starts, 1);
  await f.act('ensure', { taskId: '2', title: 'Other session' });
  await f.act('claim', { taskId: '2' });
  await assert.rejects(f.act('terminalConnection', { taskId: '2', terminalId }), /belong/);
  assert.equal((await f.act('readTerminalOutput', { terminalId })).text, 'workspace shell');
  assert.equal((await f.act('stopTerminal', { terminalId })).state, 'exited');
  assert.equal((await f.session()).terminals[0].reason, 'cancelled');
});

test('live command controls are session-owned, retain output across restart, and cancelled exit zero is an error', async (t) => {
  const commandId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let round = 0;
  let release;
  const runners = {
    execute: async (_runner, request, _signal, progress) => {
      if (request.action === 'probe')
        return { repository: '/fixture', tools: ['shell'], shell: true };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'test' };
      if (request.action === 'diff') return { digest: 'unchanged' };
      const stopped = new Promise((resolve) => {
        release = resolve;
      });
      const start = {
        commandId,
        state: 'running',
        startedAt: Date.now(),
        output: 'hello 😀',
        chunks: [{ stream: 'stdout', text: 'hello 😀' }],
        cursor: 1,
      };
      await progress(start, async () => {
        release();
        return { state: 'stopping' };
      });
      await stopped;
      const final = {
        ...start,
        chunks: [],
        state: 'exited',
        code: 0,
        stopped: true,
        reason: 'cancelled',
      };
      await progress(final, async () => {});
      return final;
    },
  };
  const f = await fixture(async function* () {
    yield {
      type: 'result',
      message: assistant(
        round++
          ? [{ type: 'text', text: 'Command stopped' }]
          : [{ type: 'toolCall', id: 'live', name: 'shell', arguments: { command: 'test' } }],
      ),
    };
  }, runners);
  t.after(() => f.runtime.close());
  await f.act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  await f.act('configure', { runnerId: (await f.runtime.snapshot()).runners[0].id });
  await f.act('start', {
    text: 'Run a check',
    model: 'test-model',
    requestId: 'live-command-test',
  });
  const pending = await until(async () => (await f.session()).pending);
  await f.act('decide', { approvalId: pending.id, allow: true });
  await until(async () => (await f.session()).commands?.length);
  assert.equal((await f.act('readCommandOutput', { commandId })).text, 'hello 😀');
  await assert.rejects(
    f.act('stopCommand', { commandId, client: 'other-client' }),
    /Claim session/,
  );
  await f.act('ensure', { taskId: '2', title: 'Other session' });
  await f.act('claim', { taskId: '2' });
  await assert.rejects(f.act('readCommandOutput', { commandId, taskId: '2' }), /belong/);
  await assert.rejects(f.act('stopCommand', { commandId, taskId: '2' }), /belong/);
  await f.act('stopCommand', { commandId });
  await until(async () => !(await f.session()).control.busy);
  const s = await f.session();
  assert.equal(s.commands[0].state, 'exited');
  assert.equal(s.events.find((e) => e.type === 'tool_result' && e.callId === 'live').isError, true);
  await f.runtime.close();
  const restarted = await createRuntime(f.options);
  t.after(() => restarted.close());
  await restarted.command({ action: 'claim', taskId: '1', client: 'test-web-client' });
  assert.equal(
    (
      await restarted.command({
        action: 'readCommandOutput',
        taskId: '1',
        client: 'test-web-client',
        commandId,
      })
    ).text,
    'hello 😀',
  );
});

test('agent starts, inspects and stops one session command across separate turns', async (t) => {
  const commandId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  let generation = 0;
  let stop;
  let receivedInput;
  const running = {
    commandId,
    lifetime: 'session',
    state: 'running',
    startedAt: Date.now(),
    output: 'server ready',
    chunks: [{ stream: 'stdout', text: 'server ready' }],
    cursor: 1,
    retainedBytes: 12,
  };
  const runners = {
    execute: async (_runner, request, _signal, progress) => {
      if (request.action === 'probe')
        return {
          repository: '/fixture',
          tools: [
            'shell',
            'start_command',
            'command_status',
            'read_command_output',
            'send_command_input',
            'stop_command',
          ],
          shell: true,
        };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'test' };
      if (request.action === 'diff') return { digest: 'unchanged' };
      if (request.action === 'command_input') {
        receivedInput = request.input;
        return {
          commandId,
          acceptedBytes: Buffer.byteLength(request.input),
          closed: request.close ?? false,
        };
      }
      if (request.name !== 'start_command')
        throw new Error('Command status and stop must stay coordinator-owned.');
      stop = async () => {
        const final = {
          ...running,
          state: 'exited',
          code: 0,
          stopped: true,
          reason: 'cancelled',
          chunks: [],
          endedAt: Date.now(),
        };
        await progress(final, stop);
        return final;
      };
      await progress(running, stop);
      return running;
    },
  };
  const messages = [
    [
      {
        type: 'toolCall',
        id: 'start-bg',
        name: 'start_command',
        arguments: { command: 'serve', yieldMs: 10 },
      },
    ],
    [{ type: 'text', text: 'Server started' }],
    [
      {
        type: 'toolCall',
        id: 'read-bg',
        name: 'read_command_output',
        arguments: { commandId, cursor: 0 },
      },
    ],
    [{ type: 'text', text: 'Output read' }],
    [
      {
        type: 'toolCall',
        id: 'input-bg',
        name: 'send_command_input',
        arguments: { commandId, input: 'ship\n' },
      },
    ],
    [{ type: 'text', text: 'Input sent' }],
    [{ type: 'toolCall', id: 'status-bg', name: 'command_status', arguments: { commandId } }],
    [{ type: 'text', text: 'Server is live' }],
    [{ type: 'toolCall', id: 'stop-bg', name: 'stop_command', arguments: { commandId } }],
    [{ type: 'text', text: 'Server stopped' }],
  ];
  const f = await fixture(async function* () {
    yield { type: 'result', message: assistant(messages[generation++]) };
  }, runners);
  t.after(() => f.runtime.close());
  await f.act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  await f.act('configure', { runnerId: (await f.runtime.snapshot()).runners[0].id });
  await f.act('start', { text: 'Start it', model: 'test-model', requestId: 'background-start' });
  let approval = await until(async () => (await f.session()).pending);
  await f.act('decide', { approvalId: approval.id, allow: true });
  await until(async () => (await f.session()).status === 'awaiting_review');
  let s = await f.session();
  assert.equal(s.commands[0].state, 'running');
  assert.equal(s.control.busy, false);
  await f.act('start', {
    text: 'Read output',
    model: 'test-model',
    requestId: 'background-output',
  });
  await until(async () => {
    const current = await f.session();
    return current.status === 'awaiting_review' && !current.control.busy && generation >= 4;
  });
  s = await f.session();
  const outputResult = s.events.find((e) => e.type === 'tool_result' && e.callId === 'read-bg');
  assert.equal(outputResult.output.text, 'server ready');
  await f.act('start', { text: 'Send input', model: 'test-model', requestId: 'background-input' });
  approval = await until(async () => (await f.session()).pending);
  assert.equal(approval.tool, 'send_command_input');
  await f.act('decide', { approvalId: approval.id, decision: 'allow_once' });
  await until(async () => {
    const current = await f.session();
    return current.status === 'awaiting_review' && !current.control.busy && generation >= 6;
  });
  assert.equal(receivedInput, 'ship\n');
  await f.act('start', { text: 'Check it', model: 'test-model', requestId: 'background-status' });
  await until(async () => {
    const current = await f.session();
    return current.status === 'awaiting_review' && !current.control.busy && generation >= 8;
  });
  s = await f.session();
  const statusResult = s.events.find((e) => e.type === 'tool_result' && e.callId === 'status-bg');
  assert.equal(statusResult.output.state, 'running');
  await f.act('start', { text: 'Stop it', model: 'test-model', requestId: 'background-stop' });
  approval = await until(async () => (await f.session()).pending);
  assert.equal(approval.tool, 'stop_command');
  await f.act('decide', { approvalId: approval.id, allow: true });
  await until(async () => {
    const current = await f.session();
    return current.status === 'awaiting_review' && !current.control.busy && generation >= 10;
  });
  s = await f.session();
  assert.equal(s.commands[0].state, 'exited');
  assert.equal(s.commands[0].reason, 'cancelled');
  assert.equal(typeof stop, 'function');
});
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
async function fixture(generate, runners) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-runtime-test-'));
  const options = {
    directory,
    generate,
    runners,
    models: [{ id: 'test-model' }],
    auth: credential,
  };
  const runtime = await createRuntime(options);
  const act = (action, input = {}) =>
    runtime.command({ action, taskId: '1', client: 'test-web-client', ...input });
  await act('ensure', { title: 'Test task' });
  await act('claim', { label: 'Web' });
  return { runtime, options, act, session: async () => (await runtime.snapshot('1')).sessions[0] };
}
test('durable run, idempotency, native/web leases, instruction pinning, restart replay', async () => {
  let release;
  let calls = 0;
  const fixtureData = await fixture(async function* () {
    calls++;
    yield { type: 'delta', text: 'Hello' };
    await new Promise((r) => {
      release = r;
    });
    yield { type: 'result', message: assistant([{ type: 'text', text: 'Hello' }]) };
  });
  const { runtime, options, act, session } = fixtureData;
  await act('publishInstruction', {
    name: 'AGENTS.md',
    scope: 'project',
    content: 'First version',
  });
  await act('configure', {});
  await act('publishInstruction', {
    name: 'AGENTS.md',
    scope: 'project',
    content: 'Second version',
  });
  await act('start', { text: 'Hello', model: 'test-model', requestId: 'request-one' });
  await until(() => release);
  assert.equal((await session()).status, 'running');
  assert.equal((await session()).instructions[0].version, 1);
  await act('start', { text: 'Hello', model: 'test-model', requestId: 'request-one' });
  assert.equal(calls, 1);
  await assert.rejects(
    act('claim', { client: 'native-terminal', label: 'Terminal' }),
    /controlled/,
  );
  await act('release');
  await act('claim', { client: 'native-terminal', label: 'Terminal' });
  await assert.rejects(act('stop'), /Claim session control/);
  release();
  await until(async () => (await session()).status === 'awaiting_review');
  assert.match((await session()).provenance.systemPrompt, /First version/);
  await runtime.close();
  const restarted = await createRuntime(options);
  assert.equal(
    (await restarted.snapshot('1')).sessions[0].events.filter((e) => e.type === 'assistant').length,
    1,
  );
  assert.equal((await restarted.snapshot('1')).sessions[0].lease, null);
  assert.equal(calls, 1);
  await restarted.close();
});

test('organization, user and project instructions form a stable epoch while runtime facts stay in the turn', async (t) => {
  let request;
  const f = await fixture(async function* (input) {
    request = structuredClone(input);
    yield { type: 'result', message: assistant([{ type: 'text', text: 'Done' }]) };
  });
  t.after(() => f.runtime.close());
  await f.act('publishInstruction', {
    name: 'ORG.md',
    scope: 'organization',
    content: 'Organization rules',
  });
  await f.act('publishInstruction', {
    name: 'USER.md',
    scope: 'user',
    content: 'User preferences',
  });
  await f.act('publishInstruction', {
    name: 'AGENTS.md',
    scope: 'project',
    content: 'Project rules',
  });
  await f.act('configure');
  await f.act('start', {
    text: 'Inspect context',
    model: 'test-model',
    requestId: 'context-layers',
  });
  await until(async () => (await f.session()).status === 'awaiting_review');
  const session = await f.session();
  assert.deepEqual(
    session.instructions.map((value) => value.scope),
    ['organization', 'user', 'project'],
  );
  assert.ok(request.sessionId);
  assert.equal(request.sessionId, session.currentAgentSessionId);
  assert.match(
    request.systemPrompt,
    /Organization rules[\s\S]*User preferences[\s\S]*Project rules/,
  );
  assert.doesNotMatch(request.systemPrompt, /Inspect context|convoy_runtime_snapshot/);
  assert.match(JSON.stringify(request.messages), /convoy_runtime_snapshot/);
  assert.equal(session.provenance.contextEpoch.id, session.contextEpoch.id);
});

test('tool execution requires exact approval; workflows enforce artifacts, gates and immutable versions', async () => {
  let executions = 0;
  let turn = 0;
  let artifact = '# Wrong';
  const runners = {
    execute: async (_runner, request) => {
      if (request.action === 'probe')
        return { repository: '/fixture', tools: ['read_file', 'write_file'], shell: false };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'convoy/test' };
      if (request.action === 'diff') return { status: '', diff: '', digest: 'digest' };
      if (request.name === 'read_file') return { text: artifact, sha256: 'artifact-hash' };
      executions++;
      artifact = '# Scope\nDone';
      return { saved: true };
    },
  };
  const { runtime, act, session } = await fixture(async function* () {
    yield {
      type: 'result',
      message: assistant(
        turn++ === 0
          ? [
              {
                type: 'toolCall',
                id: 'tool-1',
                name: 'write_file',
                arguments: { path: 'brief.md', content: '# Scope\nDone', expectedHash: '' },
              },
            ]
          : [
              {
                type: 'toolCall',
                id: 'submit',
                name: 'submit_step',
                arguments: { summary: 'Finished', artifacts: ['brief.md'] },
              },
            ],
      ),
    };
  }, runners);
  await act('saveWorkflow', {
    workflow: {
      name: 'Test',
      steps: [
        {
          name: 'Brief',
          kind: 'agent',
          prompt: 'Write brief',
          artifact: { path: 'brief.md', headings: ['Scope'] },
        },
        { name: 'Approval', kind: 'human', prompt: 'Review brief' },
      ],
    },
  });
  await act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  const runnerId = (await runtime.snapshot()).runners[0].id;
  await act('configure', { runnerId, workflow: true });
  const version = (await session()).workflow.version;
  await act('saveWorkflow', {
    workflow: { name: 'New template', steps: [{ name: 'New', kind: 'human', prompt: 'New' }] },
  });
  assert.equal((await session()).workflow.version, version);
  await assert.rejects(act('advance'), /explicit workflow/);
  await act('startWorkflow');
  const pending = await until(async () => (await session()).pending);
  assert.equal(executions, 0);
  await assert.rejects(act('decide', { approvalId: 'wrong', allow: true }), /no longer pending/);
  await act('decide', { approvalId: pending.id, allow: true });
  const waitingForReview = await until(async () => {
    const value = await session();
    return value.status === 'waiting_gate' && value;
  });
  const reviewArtifact = waitingForReview.flow.lastSubmission.artifacts[0];
  assert.equal(reviewArtifact.path, 'brief.md');
  assert.match(reviewArtifact.hash, /^[a-f0-9]{64}$/);
  assert.equal(waitingForReview.flow.lastSubmission.primaryArtifactId, reviewArtifact.id);
  assert.equal((await runtime.readContext(waitingForReview.id, reviewArtifact.id)).bytes.toString(), '# Scope\nDone');
  assert.equal(executions, 1);
  await assert.rejects(
    act('start', { text: 'Bypass', model: 'test-model', requestId: 'bypass' }),
    /workflow/,
  );
  await act('approveGate', { instance: (await session()).flow.instance });
  assert.equal((await session()).status, 'accepted');
  const audit = (await session()).events.find((e) => e.type === 'step_submitted');
  assert.equal(audit.evidence.artifact.hash, 'artifact-hash');
  await runtime.close();
});

test('restart marks pending work interrupted and reconciles unresolved tool calls without execution', async () => {
  const { runtime, options, session } = await fixture(async function* () {
    throw new Error('Must not run');
  });
  await runtime.close();
  const path = join(options.directory, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.sessions['1'].status = 'waiting_approval';
  state.sessions['1'].pending = { id: 'pending' };
  state.sessions['1'].messages.push(
    assistant([
      { type: 'toolCall', id: 'unknown-operation', name: 'write_file', arguments: { path: 'x' } },
    ]),
  );
  await writeFile(path, JSON.stringify(state));
  const restarted = await createRuntime(options);
  const s = (await restarted.snapshot('1')).sessions[0];
  assert.equal(s.status, 'interrupted');
  assert.equal(s.pending, null);
  assert.match(s.events.at(-1).message, /not replayed/);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.match(persisted.sessions['1'].messages.at(-1).content[0].text, /outcome is unknown/);
  await restarted.close();
});

test('verification gates reject changed code and accept only the configured successful check', async () => {
  let round = 0;
  let fingerprint = 'original-code';
  const runners = {
    execute: async (_runner, request) => {
      if (request.action === 'probe')
        return { repository: '/fixture', tools: ['shell'], shell: true };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'test' };
      if (request.action === 'diff') return { digest: fingerprint };
      return { code: 0, output: 'passed', stopped: false };
    },
  };
  const { runtime, act, session } = await fixture(async function* () {
    yield {
      type: 'result',
      message: assistant(
        round++ === 0
          ? [{ type: 'toolCall', id: 'check', name: 'shell', arguments: { command: 'npm test' } }]
          : [
              {
                type: 'toolCall',
                id: 'submit',
                name: 'submit_step',
                arguments: { summary: 'Checks passed', artifacts: [] },
              },
            ],
      ),
    };
  }, runners);
  await assert.rejects(
    act('saveWorkflow', {
      workflow: {
        name: 'Invalid',
        steps: [{ name: 'Verify', kind: 'agent', prompt: 'Test', requiresCheck: true }],
      },
    }),
    /required/,
  );
  await act('saveWorkflow', {
    workflow: {
      name: 'Check',
      steps: [
        {
          name: 'Verify',
          kind: 'agent',
          prompt: 'Test',
          requiresCheck: true,
          checkCommand: 'npm test',
          advance: 'manual',
        },
      ],
    },
  });
  await act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  await act('configure', { runnerId: (await runtime.snapshot()).runners[0].id, workflow: true });
  await act('startWorkflow');
  const approval = await until(async () => (await session()).pending);
  await act('decide', { approvalId: approval.id, allow: true });
  await until(async () => (await session()).status === 'awaiting_continue');
  const instance = (await session()).flow.instance;
  fingerprint = 'modified-after-check';
  await assert.rejects(act('continueWorkflow', { instance }), /current workspace/);
  fingerprint = 'original-code';
  await act('continueWorkflow', { instance });
  assert.equal((await session()).status, 'accepted');
  await runtime.close();
});

test('stopping at an approval never executes the pending tool', async () => {
  let executed = false;
  const runners = {
    execute: async (_runner, request) => {
      if (request.action === 'probe')
        return { repository: '/fixture', tools: ['write_file'], shell: false };
      if (request.action === 'provision') return { path: '/fixture/task', branch: 'test' };
      executed = true;
    },
  };
  const { runtime, act, session } = await fixture(async function* () {
    yield {
      type: 'result',
      message: assistant([
        {
          type: 'toolCall',
          id: 'write',
          name: 'write_file',
          arguments: { path: 'file', content: 'test', expectedHash: '' },
        },
      ]),
    };
  }, runners);
  await act('registerRunner', { name: 'Local', kind: 'local', repository: '/fixture' });
  await act('configure', { runnerId: (await runtime.snapshot()).runners[0].id });
  await act('start', { text: 'Write', model: 'test-model', requestId: 'stop-request' });
  await until(async () => (await session()).pending);
  await act('stop');
  await until(async () => (await session()).status === 'interrupted');
  assert.equal(executed, false);
  assert.equal((await session()).pending, null);
  await runtime.close();
});

test('brief, approval, implementation, independent review and revision preserve intended sessions', async () => {
  const prompts = [];
  const { runtime, act, session, options } = await fixture(async function* ({
    messages,
    systemPrompt,
    tools,
  }) {
    prompts.push({ messages: structuredClone(messages), systemPrompt, tools });
    yield {
      type: 'result',
      message: assistant([
        {
          type: 'toolCall',
          id: `submit-${prompts.length}`,
          name: 'submit_step',
          arguments: { summary: 'Step evidence', artifacts: [] },
        },
      ]),
    };
  });
  const agent = (id, sessionRule) => ({
    id,
    name: id,
    kind: 'agent',
    prompt: `Do ${id}`,
    permissions: 'none',
    session: sessionRule,
  });
  await act('saveWorkflow', {
    workflow: {
      id: 'acceptance',
      name: 'Acceptance',
      steps: [
        agent('brief'),
        { id: 'approve', name: 'Approve', kind: 'human', prompt: 'Review brief' },
        agent('implement'),
        agent('review', { mode: 'new', name: 'reviewer' }),
        {
          id: 'accept',
          name: 'Accept',
          kind: 'human',
          prompt: 'Review result',
          revisionTarget: 'implement',
        },
      ],
    },
  });
  await act('configure', { workflow: 'acceptance' });
  await act('startWorkflow');
  await until(async () => (await session()).flow.status === 'waiting_gate');
  const main = (await session()).currentAgentSessionId;
  const firstGate = (await session()).flow.instance;
  await act('approveGate', { instance: firstGate });
  await until(
    async () => (await session()).step === 4 && (await session()).status === 'waiting_gate',
  );
  let s = await session();
  assert.notEqual(s.currentAgentSessionId, main);
  assert.equal(s.agentSessions.length, 2);
  assert.match(prompts[1].messages[0].content, /Do brief/);
  assert.equal(prompts[2].messages.length, 2);
  assert.match(prompts[2].messages[1].content, /convoy_runtime_snapshot/);
  assert.ok(prompts.every((p) => JSON.stringify(p.tools) === JSON.stringify(prompts[0].tools)));
  assert.match(prompts[0].systemPrompt, /"available":\["ask_user","submit_step"\]/);
  await assert.rejects(act('approveGate', { instance: firstGate }), /changed/);
  await act('requestChanges', { instance: s.flow.instance, feedback: 'Handle empty input' });
  await until(
    async () => (await session()).step === 4 && (await session()).status === 'waiting_gate',
  );
  s = await session();
  const routes = s.events.filter((e) => e.type === 'session_routed' && e.stepId === 'implement');
  assert.equal(routes.length, 2);
  assert.ok(routes.every((e) => e.agentSessionId === main));
  assert.match(prompts[3].messages.at(-1).content, /Handle empty input/);
  assert.equal(s.flow.revision, 1);
  assert.ok(!JSON.stringify(s.agentSessions).includes('toolResult'));
  await runtime.close();
  const restarted = await createRuntime(options);
  assert.equal((await restarted.snapshot('1')).sessions[0].flow.status, 'waiting_gate');
  assert.equal(prompts.length, 5);
  await restarted.command({
    action: 'claim',
    taskId: '1',
    client: 'test-web-client',
    label: 'Web',
  });
  await restarted.command({
    action: 'approveGate',
    taskId: '1',
    client: 'test-web-client',
    instance: s.flow.instance,
  });
  const completed = await restarted.snapshot('1');
  assert.equal(completed.sessions[0].flow.status, 'completed');
  assert.equal(completed.tickets[0].status, 'Backlog');
  await restarted.close();
});

test('ordinary replies never advance; questions are separate; pause and restart require explicit continuation', async () => {
  let turns = 0;
  const { runtime, act, session, options } = await fixture(async function* () {
    turns++;
    yield {
      type: 'result',
      message: assistant(
        turns === 1
          ? [{ type: 'text', text: 'Not submitted' }]
          : turns === 2
            ? [
                {
                  type: 'toolCall',
                  id: 'question',
                  name: 'ask_user',
                  arguments: { question: 'Which format?' },
                },
              ]
            : [
                {
                  type: 'toolCall',
                  id: 'submit',
                  name: 'submit_step',
                  arguments: { summary: 'Done', artifacts: [] },
                },
              ],
      ),
    };
  });
  await act('saveWorkflow', {
    workflow: {
      id: 'questions',
      name: 'Questions',
      steps: [{ id: 'work', name: 'Work', kind: 'agent', prompt: 'Do work' }],
    },
  });
  await act('configure', { workflow: 'questions' });
  await act('startWorkflow');
  await until(async () => (await session()).status === 'awaiting_submission');
  assert.equal((await session()).step, 0);
  await act('pauseWorkflow');
  await act('pauseWorkflow');
  await runtime.close();
  const restarted = await createRuntime(options);
  assert.equal((await restarted.snapshot('1')).sessions[0].flow.status, 'paused');
  assert.equal(turns, 1);
  const command = (action, extra = {}) =>
    restarted.command({ action, taskId: '1', client: 'test-web-client', ...extra });
  await command('claim', { label: 'Web' });
  await command('continueWorkflow', {
    instance: (await restarted.snapshot('1')).sessions[0].flow.instance,
  });
  const question = await until(
    async () => (await restarted.snapshot('1')).sessions[0].pendingQuestion,
  );
  await assert.rejects(
    command('approveGate', { instance: (await restarted.snapshot('1')).sessions[0].flow.instance }),
    /current agent/,
  );
  await command('answerQuestion', { questionId: question.id, answer: 'Markdown' });
  await until(async () => (await restarted.snapshot('1')).sessions[0].status === 'accepted');
  await restarted.close();
});

test('drafts allow unfinished steps; published versions reject conflicting saves and invalid routes', async () => {
  const { runtime, act } = await fixture(async function* () {});
  const draft = { id: 'draft', name: '', steps: [] };
  await act('saveWorkflowDraft', { workflow: draft, revision: 0 });
  await assert.rejects(
    act('saveWorkflowDraft', { workflow: draft, revision: 0 }),
    /another client/,
  );
  await assert.rejects(act('saveWorkflow', { workflow: draft }), /required|workflow nodes/);
  const workflow = {
    id: 'draft',
    name: 'Valid',
    steps: [
      {
        id: 'one',
        name: 'Work',
        prompt: 'Work',
        kind: 'agent',
        session: { mode: 'reuse', target: 'missing' },
      },
    ],
  };
  await assert.rejects(act('saveWorkflow', { workflow }), /not been created/);
  workflow.steps[0].session = { mode: 'continue' };
  await act('saveWorkflow', { workflow, baseVersion: 0 });
  await assert.rejects(act('saveWorkflow', { workflow, baseVersion: 0 }), /another client/);
  assert.equal((await runtime.snapshot()).workflowDrafts.draft, undefined);
  await runtime.close();
});
