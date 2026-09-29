import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { executeRunner, processRun } from '../../packages/runner/src/index.mjs';

const message = (content) => ({
  role: 'assistant',
  content,
  stopReason: 'stop',
  timestamp: Date.now(),
});
const call = (id, name, args) => message([{ type: 'toolCall', id, name, arguments: args }]);

test('investigation: effective schemas, retained pages, finalization enforcement and honest incomplete status', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-investigation-'));
  let runtime;
  let runners;
  t.after(async () => {
    await runtime?.close();
    await runners?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await processRun('git', ['init', '-q', directory]);
  await writeFile(join(directory, 'README.md'), 'Fixture repository\n');
  await processRun('git', ['add', 'README.md'], { cwd: directory });
  await processRun(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: directory },
  );
  if (!(await executeRunner({ action: 'probe', repository: directory })).inspection) {
    assert.notEqual(process.env.CONVOY_REQUIRE_INSPECTION, '1');
    return t.skip('Inspection sandbox unavailable');
  }
  runners = createRunners();
  let round = 0;
  const requests = [];
  let commandId;
  runtime = await createRuntime({
    directory: join(directory, 'state'),
    runners,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      requests.push(input);
      round++;
      assert.equal(input.modelSettings.reasoningEffort, 'medium');
      assert.ok(
        !input.tools.some((tool) =>
          ['write_file', 'start_command', 'search_files'].includes(tool.name),
        ),
      );
      let result;
      if (round === 1) result = call('large-output', 'shell', { command: 'seq 1 10000' });
      if (round === 2) {
        const history = JSON.stringify(input.prompt.messages);
        assert.match(history, /bytes omitted from preview/);
        commandId = JSON.parse(
          input.prompt.messages.find((m) => m.role === 'toolResult' && m.toolName === 'shell')
            .content[0].text,
        ).commandId;
        result = call('recover', 'read_command_output', { commandId, cursor: 0 });
      }
      if (round === 3) {
        assert.deepEqual(
          input.tools.map((tool) => tool.name),
          ['finish_incomplete', 'submit_step'],
        );
        assert.match(input.prompt.turnInstructions, /during finalization use finish_incomplete/);
        const latestState = input.prompt.messages.findLast(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Convoy runtime snapshot'));
        assert.match(latestState.content, /"finalizing":true/);
        assert.match(JSON.stringify(input.prompt.messages), /32768/);
        result = call('forbidden-finalization-read', 'shell', { command: 'cat README.md' });
      }
      if (round === 4) {
        assert.deepEqual(
          input.tools.map((tool) => tool.name),
          ['finish_incomplete', 'submit_step'],
        );
        assert.match(input.prompt.turnInstructions, /during finalization use finish_incomplete/);
        const latestState = input.prompt.messages.findLast(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Convoy runtime snapshot'));
        assert.match(latestState.content, /"finalizing":true/);
        assert.match(JSON.stringify(input.prompt.messages), /Tool was not exposed/);
        result = message([
          {
            type: 'text',
            text: 'Investigation incomplete. Next: inspect the relevant validation path.',
          },
        ]);
      }
      yield { type: 'result', message: result };
    },
  });
  const act = (action, input = {}) =>
    runtime.command({ action, client: 'investigation-test', ...input });
  const runner = await act('registerRunner', {
    name: 'Fixture',
    kind: 'local',
    repository: directory,
  });
  const profile = await act('publishProfile', {
    id: 'inspect-evidence',
    name: 'Inspect evidence',
    tools: ['convoy.shell', 'convoy.read_command_output'],
    skills: [],
  });
  const project = (await runtime.snapshot()).projects.find((p) => p.id === 'agent-platform');
  await act('setExecutionProfile', {
    projectId: project.id,
    revision: project.revision,
    profile: 'inspect',
  });
  await act('saveWorkflow', {
    workflow: {
      id: 'investigate',
      name: 'Investigate',
      capabilityProfile: { id: profile.id, version: profile.version },
      nodes: [
        {
          id: 'inspect',
          name: 'Inspect',
          kind: 'agent',
          permissions: 'read',
          maxRounds: 4,
          finalizationRounds: 2,
          reasoningEffort: 'medium',
          prompt: 'Investigate; do not submit without evidence.',
        },
        { id: 'review', name: 'Review', kind: 'human', prompt: 'Review' },
      ],
      edges: [{ id: 'review', from: 'inspect', to: 'review', outcome: 'success' }],
    },
  });
  const ticket = await act('createTicket', {
    projectId: project.id,
    requestId: 'fixture-ticket',
    title: 'Investigate',
  });
  const run = await act('runTicket', {
    ticketId: ticket.id,
    revision: ticket.revision,
    mode: 'new',
    workflowId: 'investigate',
    workflowVersion: 1,
    model: 'fixture',
    placement: { mode: 'pinned', runnerId: runner.id },
    requestId: 'fixture-run',
  });
  let completed;
  for (let n = 0; n < 500; n++) {
    const current = (await runtime.snapshot(run.sessionId)).sessions[0];
    if (!current.control.busy && ['failed', 'awaiting_submission'].includes(current.status)) {
      completed = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    completed?.status,
    'awaiting_submission',
    JSON.stringify(completed?.events.slice(-5)),
  );
  assert.equal(round, 4);
  assert.equal(completed.commands.length, 1);
  assert.equal(completed.flow.nodeId, 'inspect');
  assert.equal(completed.events.filter((e) => e.type === 'model_request_settings').length, 4);
  const results = completed.events.filter((e) => e.type === 'tool_result');
  assert.equal(results.find((e) => e.tool === 'read_command_output').isError, false);
  assert.equal(results.find((e) => e.callId === 'forbidden-finalization-read').isError, true);
});
