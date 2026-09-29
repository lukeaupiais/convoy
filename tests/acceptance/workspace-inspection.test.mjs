import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { executeRunner, processRun } from '../../packages/runner/src/index.mjs';
const reply = (content) => ({
  role: 'assistant',
  content,
  stopReason: 'stop',
  timestamp: Date.now(),
});
async function until(read) {
  for (let n = 0; n < 500; n++) {
    const s = await read();
    if (!s.control.busy && ['failed', 'interrupted', 'queued'].includes(s.status))
      throw new Error(JSON.stringify(s.events.slice(-4)));
    if (!s.control.busy && s.status === 'awaiting_review') return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}

for (const scenario of [
  { name: 'inventory', directory: 'modules/stock', text: 'Inventory evidence', tracked: false },
  {
    name: 'publishing',
    directory: 'services/articles',
    text: 'Publishing evidence',
    tracked: true,
  },
])
  test(`inspection end-to-end: ${scenario.name} guidance, native navigation, capture refresh and profile off`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-inspection-e2e-'));
    let runtime;
    let runners;
    t.after(async () => {
      await runtime?.close();
      await runners?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await processRun('git', ['init', '-q', repository]);
    await mkdir(join(repository, scenario.directory), { recursive: true });
    await writeFile(join(repository, scenario.directory, 'entry.txt'), scenario.text);
    await writeFile(
      join(repository, 'README.md'),
      `Implementation lives in ${scenario.directory}.`,
    );
    await writeFile(join(repository, '.gitignore'), scenario.tracked ? '' : 'AGENTS.md\n');
    const guidance = `UNIQUE_GUIDANCE_${scenario.name}: read README.md, then inspect ${scenario.directory}/entry.txt.`;
    await writeFile(join(repository, 'AGENTS.md'), guidance);
    await processRun('git', ['add', '.'], { cwd: repository });
    await processRun(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repository },
    );
    if (!(await executeRunner({ action: 'probe', repository })).inspection) {
      assert.notEqual(
        process.env.CONVOY_REQUIRE_INSPECTION,
        '1',
        'Required inspection sandbox unavailable',
      );
      return t.skip('Inspection sandbox unavailable');
    }
    runners = createRunners();
    let round = 0;
    const prompts = [];
    runtime = await createRuntime({
      directory: join(directory, 'state'),
      runners,
      models: [{ id: 'fixture' }],
      auth: { token: async () => 'test', status: async () => ({ connected: true }) },
      generate: async function* (input) {
        prompts.push(JSON.stringify(input.prompt ?? input));
        round++;
        yield {
          type: 'result',
          message:
            round === 1
              ? reply([
                  {
                    type: 'toolCall',
                    id: 'native-read',
                    name: 'shell',
                    arguments: {
                      command: `pwd; ls; sed -n '1,10p' README.md; rg --files ${scenario.directory}; sed -n '1,10p' ${scenario.directory}/entry.txt`,
                    },
                  },
                ])
              : reply([{ type: 'text', text: `Evidence: ${scenario.directory}/entry.txt` }]),
        };
      },
    });
    const command = (action, input = {}) =>
      runtime.command({ action, client: 'inspection-e2e', ...input });
    const runner = await command('registerRunner', { name: 'Fixture', kind: 'local', repository });
    const profile = await command('publishProfile', {
      id: 'investigation',
      name: 'Investigation',
      tools: ['convoy.shell'],
      skills: [],
      loadWorkspaceAgentsMd: true,
    });
    const project = (await runtime.snapshot()).projects.find((p) => p.id === 'agent-platform');
    await command('setExecutionProfile', {
      projectId: project.id,
      revision: project.revision,
      profile: 'inspect',
    });
    const conversation = await command('createConversation', {
      projectId: project.id,
      requestId: 'inspection',
      placement: { mode: 'pinned', runnerId: runner.id },
    });
    const sessionId = conversation.sessionId;
    const session = async () => (await runtime.snapshot(sessionId)).sessions[0];
    await command('claim', { sessionId });
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: profile.id, version: profile.version },
    });
    await command('start', {
      sessionId,
      model: 'fixture',
      text: 'Locate implementation evidence.',
      requestId: 'first-turn',
    });
    const completed = await until(session);
    assert.equal(completed.executionGrant.profileId, 'inspect');
    assert.equal(completed.workspaceGuidance.status, 'loaded');
    assert.equal(
      completed.workspaceGuidance.source.kind,
      scenario.tracked ? 'workspace' : 'seeded',
    );
    assert.ok(prompts[0].includes(guidance));
    assert.ok(prompts[1].includes(scenario.text));
    assert.equal(completed.commands.at(-1).code, 0);
    assert.ok(completed.commands.at(-1).output.includes(scenario.text));
    assert.ok(
      !JSON.stringify(await runtime.snapshot()).includes(guidance),
      'general snapshots contain only guidance metadata',
    );
    assert.equal(
      await readFile(join(completed.workspace.path, scenario.directory, 'entry.txt'), 'utf8'),
      scenario.text,
    );
    const before = completed.workspaceGuidance.id;
    await writeFile(join(completed.workspace.path, 'AGENTS.md'), 'Refreshed guidance');
    await command('refreshWorkspaceGuidance', { sessionId, captureId: before });
    const refreshed = await session();
    assert.notEqual(refreshed.workspaceGuidance.id, before);
    await assert.rejects(
      command('refreshWorkspaceGuidance', { sessionId, captureId: before }),
      /changed/,
    );
    const off = await command('publishProfile', {
      id: profile.id,
      name: profile.name,
      baseVersion: profile.version,
      tools: ['convoy.shell'],
      skills: [],
      loadWorkspaceAgentsMd: false,
    });
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: off.id, version: off.version },
    });
    assert.equal((await session()).workspaceGuidance.status, 'disabled');
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: profile.id, version: profile.version },
    });
    assert.equal(
      (await session()).workspaceGuidance.status,
      'pending',
      'off -> on without a turn retires the loaded capture',
    );
    await writeFile(join(completed.workspace.path, 'AGENTS.md'), Buffer.from([0xff]));
    await assert.rejects(
      command('refreshWorkspaceGuidance', {
        sessionId,
        captureId: (await session()).workspaceGuidance.id,
      }),
      /Workspace guidance/,
    );
    assert.equal((await session()).workspaceGuidance.status, 'error');
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: off.id, version: off.version },
    });
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: profile.id, version: profile.version },
    });
    assert.equal(
      (await session()).workspaceGuidance.status,
      'pending',
      'off -> on also retires an error',
    );
    await writeFile(
      join(completed.workspace.path, 'AGENTS.md'),
      'Valid replacement character: \uFFFD',
    );
    await command('refreshWorkspaceGuidance', {
      sessionId,
      captureId: (await session()).workspaceGuidance.id,
    });
    assert.equal((await session()).workspaceGuidance.status, 'loaded');
    await command('setCapabilityProfile', {
      sessionId,
      profile: { id: off.id, version: off.version },
    });
    await command('start', {
      sessionId,
      model: 'fixture',
      text: 'Summarize the evidence.',
      requestId: 'second-turn',
    });
    await until(session);
    assert.ok(!prompts.at(-1).includes('Refreshed guidance'));
  });

for (const projectDefault of ['auto', 'inspect'])
  test(`read-node triage submits evidence and hands off to separately authorized development (${projectDefault} default)`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-inspection-workflow-'));
    let runtime;
    const runners = createRunners();
    t.after(async () => {
      await runtime?.close();
      await runners.close();
      await rm(directory, { recursive: true, force: true });
    });
    const repository = join(directory, 'repo');
    await mkdir(repository);
    await processRun('git', ['init', '-q', repository]);
    await writeFile(join(repository, 'README.md'), 'Review source.txt for evidence.');
    await writeFile(join(repository, 'source.txt'), 'original');
    await processRun('git', ['add', '.'], { cwd: repository });
    await processRun(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repository },
    );
    if (!(await executeRunner({ action: 'probe', repository })).inspection) {
      assert.notEqual(process.env.CONVOY_REQUIRE_INSPECTION, '1');
      return t.skip('Inspection unavailable');
    }
    let inspectionCalls = 0;
    let developmentCalls = 0;
    let allCalls = 0;
    runtime = await createRuntime({
      directory: join(directory, 'state'),
      runners,
      models: [{ id: 'fixture' }],
      auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
      generate: async function* (input) {
        allCalls++;
        const investigate = input.prompt.turnInstructions.includes('Investigate evidence');
        const n = investigate ? ++inspectionCalls : ++developmentCalls;
        const call =
          n === 1
            ? investigate
              ? { name: 'shell', arguments: { command: 'sed -n 1p source.txt' } }
              : {
                  name: 'write_file',
                  arguments: {
                    path: 'implementation.txt',
                    content: 'implemented',
                    expectedHash: '',
                  },
                }
            : {
                name: 'submit_step',
                arguments: {
                  summary: 'Source evidence reviewed',
                  artifacts: [],
                  outcome: 'success',
                },
              };
        yield {
          type: 'result',
          message: reply([{ type: 'toolCall', id: `call-${allCalls}`, ...call }]),
        };
      },
    });
    const act = (action, input = {}) =>
      runtime.command({ action, client: 'workflow-inspection', ...input });
    const project = (await runtime.snapshot()).projects.find((p) => p.id === 'agent-platform');
    await act('setExecutionProfile', {
      projectId: project.id,
      revision: project.revision,
      profile: projectDefault,
    });
    const runner = await act('registerRunner', { name: 'Local', kind: 'local', repository });
    const inspectionProfile = await act('publishProfile', {
      id: 'read-repository',
      name: 'Read repository',
      tools: ['convoy.shell'],
      skills: [],
    });
    const developmentProfile = await act('publishProfile', {
      id: 'develop',
      name: 'Develop',
      tools: ['convoy.write_file'],
      skills: [],
    });
    const board = await act('saveBoard', {
      name: 'Follow-up queue',
      projectIds: [project.id],
      columns: [{ id: 'ready', name: 'Ready' }],
    });
    await act('saveWorkflow', {
      workflow: {
        id: 'investigate',
        name: 'Investigation',
        capabilityProfile: { id: inspectionProfile.id, version: 1 },
        nodes: [
          {
            id: 'inspect',
            kind: 'agent',
            name: 'Investigate evidence',
            prompt: 'Inspect and submit evidence.',
            permissions: 'read',
          },
          { id: 'review', kind: 'human', name: 'Review evidence', prompt: 'Review the evidence.' },
          {
            id: 'follow-up',
            kind: 'action',
            name: 'Create follow-up',
            operation: 'create_related_ticket',
            input: {
              title: 'Implement correction',
              description: 'See reviewed source evidence.',
              boardId: board.id,
              kind: 'escalation',
            },
          },
        ],
        edges: [
          { from: 'inspect', to: 'review', outcome: 'success' },
          { from: 'review', to: 'follow-up', outcome: 'approved' },
        ],
      },
    });
    await act('saveWorkflow', {
      workflow: {
        id: 'develop',
        name: 'Development',
        capabilityProfile: { id: developmentProfile.id, version: 1 },
        nodes: [
          {
            id: 'implement',
            kind: 'agent',
            name: 'Implement follow-up',
            prompt: 'Implement and submit.',
          },
        ],
        edges: [],
      },
    });
    let ticket = await act('createTicket', {
      requestId: 'inspection-ticket',
      projectId: project.id,
      title: 'Investigate issue',
    });
    ticket = await act('setExecutionProfile', {
      taskId: ticket.id,
      revision: ticket.revision,
      profile: 'inspect',
    });
    const start = (ticket, workflowId, requestId) =>
      act('runTicket', {
        ticketId: ticket.id,
        revision: ticket.revision,
        mode: 'new',
        workflowId,
        workflowVersion: 1,
        model: 'fixture',
        placement: { mode: 'pinned', runnerId: runner.id },
        requestId,
      });
    const run = await start(ticket, 'investigate', 'inspect-run');
    const session = async (id) => (await runtime.snapshot(id)).sessions[0];
    const wait = async (fn) => {
      for (let i = 0; i < 500; i++) {
        const result = await fn();
        if (result) return result;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(
        JSON.stringify((await runtime.snapshot()).sessions.map((s) => s.events.slice(-4))),
      );
    };
    const gate = await wait(async () => {
      const s = await session(run.sessionId);
      return !s.control.busy && s.flow?.status === 'waiting_gate' && s;
    });
    assert.equal(gate.commands[0].code, 0);
    assert.match(gate.commands[0].output, /original/);
    assert.equal(gate.flow.lastSubmission.summary, 'Source evidence reviewed');
    const originalDigest = gate.executionGrant.digest;
    await act('approveGate', { sessionId: run.sessionId, instance: gate.flow.instance });
    const related = await wait(async () =>
      (await runtime.snapshot()).tickets.find((t) => t.title === 'Implement correction'),
    );
    assert.equal(related.executionProfile, 'inherit');
    assert.ok(!related.executionSessionId);
    let target = related;
    if (projectDefault === 'inspect')
      target = await act('setExecutionProfile', {
        taskId: target.id,
        revision: target.revision,
        profile: 'auto',
      });
    const development = await start(target, 'develop', 'development-run');
    const done = await wait(async () => {
      const s = await session(development.sessionId);
      return !s.control.busy && s.flow?.status === 'completed' && s;
    });
    assert.equal(done.executionGrant.profileId, 'auto');
    assert.notEqual(done.workspace.path, gate.workspace.path);
    assert.equal(
      await readFile(join(done.workspace.path, 'implementation.txt'), 'utf8'),
      'implemented',
    );
    assert.equal((await session(run.sessionId)).executionGrant.digest, originalDigest);
    assert.equal(await readFile(join(gate.workspace.path, 'source.txt'), 'utf8'), 'original');

    await act('saveWorkflow', {
      workflow: {
        id: 'requires-artifact',
        name: 'Artifact planning',
        capabilityProfile: { id: inspectionProfile.id, version: 1 },
        nodes: [
          {
            id: 'plan',
            kind: 'agent',
            name: 'Plan artifact',
            prompt: 'Write plan.',
            permissions: 'read-write',
            artifact: { path: 'plan.md', headings: ['Plan'] },
          },
        ],
        edges: [],
      },
    });
    let incompatible = await act('createTicket', {
      requestId: 'incompatible',
      projectId: project.id,
      title: 'Artifact workflow',
    });
    incompatible = await act('setExecutionProfile', {
      taskId: incompatible.id,
      revision: incompatible.revision,
      profile: 'inspect',
    });
    const before = allCalls;
    const blocked = await start(incompatible, 'requires-artifact', 'blocked-run');
    const failure = await wait(async () => {
      const s = await session(blocked.sessionId);
      return !s.control.busy && s.status === 'failed' && s;
    });
    assert.equal(allCalls, before);
    assert.match(JSON.stringify(failure.events), /repository artifact/);
  });
