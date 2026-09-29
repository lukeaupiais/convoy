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

test('structured submission validates actual source and exposes captured evidence without advancing on errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-investigation-'));
  let runtime;
  let runners;
  t.after(async () => {
    await runtime?.close();
    await runners?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await processRun('git', ['init', '-q', directory]);
  await writeFile(join(directory, 'README.md'), 'Fixture repository\nSecond line\nThird line\n');
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

  runtime = await createRuntime({
    directory: join(directory, 'state'),
    runners,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      requests.push(input);
      round++;
      const schema = input.tools.find((tool) => tool.name === 'submit_step').parameters;
      assert.ok(schema.required.includes('references'));
      const args = {
        summary: 'Source reviewed',
        artifacts: [],
        outcome: 'success',
        details: { basis: 'Source supports the proposal', selfCheck: 'Checked contrary evidence' },
        references: [{ path: 'README.md', startLine: 2, endLine: 3 }],
      };
      args.investigation = { questions: [{ question: 'Does the source contradict the proposal?', material: true,
        internallyAnswerable: true, status: round < 6 ? 'unresolved' : 'resolved',
        resolution: round < 6 ? '' : 'Read README lines 2–3; they support the proposal.', nextAction: 'Read README lines 2–3',
        ...(round >= 6 ? {evidence: {references: [0], establishes: 'README states the relevant source facts.', unverified: 'Application behavior was not executed.'}} : {}) }] };
      // First exercise reference validation, then reproduce the admitted-gap failure.
      if (round < 4) Object.assign(args.investigation.questions[0], {
        status: 'resolved', resolution: 'Candidate source finding.',
        evidence: {references: [0], establishes: 'Candidate source evidence.', unverified: 'Runtime behavior.'},
      });
      if (round === 6) args.investigation.questions[0].evidence.references = [1];
      if (round === 5) {
        assert.match(JSON.stringify(input.prompt.messages), /Submission blocked by unresolved material internal questions/);
        yield { type: 'result', message: call('inspect-gap', 'read_file', {path: 'README.md', offset: 2, limit: 2}) };
        return;
      }
      if (round === 1) args.details = {};
      if (round === 2) args.references[0].path = 'missing.md';
      if (round === 3) args.references[0].endLine = 20;
      if (round > 1) assert.ok(JSON.stringify(input.prompt.messages).includes('error'));
      const result = call(`submit-${round}`, 'submit_step', args);
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
    tools: ['convoy.read_file'],
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
          maxRounds: 8,
          finalizationRounds: 2,
          submissionRequirements: { success: { fields: ['basis', 'selfCheck'], minReferences: 1, requireInvestigationAssessment: true, requireClaimEvidence: true } },
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
    if (!current.control.busy && ['failed', 'waiting_gate'].includes(current.status)) {
      completed = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completed?.status, 'waiting_gate', JSON.stringify(completed?.events.slice(-5)));
  assert.equal(round, 7);
  assert.deepEqual(completed.flow.lastSubmission.investigation.questions[0].evidence.references, [0]);
  assert.equal(completed.flow.lastSubmission.investigation.questions[0].status, 'resolved');
  assert.equal(completed.flow.lastSubmission.references[0].text, 'Second line\nThird line\n');
  assert.equal(completed.flow.lastSubmission.details.selfCheck, 'Checked contrary evidence');
  assert.equal(completed.events.filter((e) => e.type === 'submission_rejected').length, 5);
  await writeFile(join(completed.workspace.path, 'README.md'), 'Changed externally\n');
  assert.equal(
    (await runtime.snapshot(run.sessionId)).sessions[0].flow.lastSubmission.references[0].text,
    'Second line\nThird line\n',
  );
  await act('claim', { sessionId: run.sessionId });
  await assert.rejects(
    act('approveGate', { sessionId: run.sessionId, instance: completed.flow.instance }),
    /source evidence changed/,
  );
});
