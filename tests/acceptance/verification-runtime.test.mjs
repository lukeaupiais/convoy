import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { processRun, probeVerificationRuntime } from '../../packages/runner/src/index.mjs';

test('verification workflow captures a native scenario and reaches human review after runtime teardown', async (t) => {
  if (!process.env.CONVOY_RUNTIME_TEST_IMAGE || !(await probeVerificationRuntime())) {
    assert.notEqual(process.env.CONVOY_REQUIRE_VERIFICATION, '1');
    return t.skip('Eligible runtime test bundle required');
  }
  const directory = await mkdtemp(join(tmpdir(), 'convoy-verification-acceptance-'));
  let runtime;
  const runners = createRunners();
  t.after(async () => {
    await runtime?.close();
    await runners.close();
    await rm(directory, { recursive: true, force: true });
  });
  await processRun('git', ['init', '-q', directory]);
  await writeFile(join(directory, 'README.md'), 'Document conversion fixture\n');
  await processRun('git', ['-C', directory, 'add', '.']);
  await processRun('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const head = (await processRun('git', ['-C', directory, 'rev-parse', 'HEAD'])).output.trim();
  let round = 0;
  // A captured JSON response is commonly a single line larger than the model's
  // read_file preview. Review must retain the exact sealed bytes, not a preview.
  const responseEvidence = JSON.stringify({ observations: 'é'.repeat(20000) });
  runtime = await createRuntime({
    directory: join(directory, 'state'),
    runners,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      round++;
      assert.match(JSON.stringify(input.prompt), /Disposable runtime/);
      const call =
        round === 1
          ? {
              name: 'shell',
              arguments: {
                command:
                  `printf 'Verified conversion fixture\\n' > /scratch/result.txt; node -e 'require("fs").writeFileSync("/scratch/response.json",JSON.stringify({observations:"é".repeat(20000)}))'; cat /scratch/result.txt`,
              },
            }
          : {
              name: 'submit_step',
              arguments: {
                summary: 'Document fixture checked. Observed result captured.',
                artifacts: ['scratch/result.txt', 'scratch/response.json'],
                outcome: 'success',
                details: { basis: 'Command observation' },
                references: [{ path: 'README.md', startLine: 1, endLine: 1 }],
              },
            };
      assert.ok(round <= 3, 'Unexpected repair loop');
      yield {
        type: 'result',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-' + round, ...call }],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      };
    },
  });
  const act = (action, input = {}) =>
    runtime.command({ action, client: 'verification-test', ...input });
  const project = (await runtime.snapshot()).projects[0];
  const runner = await act('registerRunner', {
    name: 'Fixture',
    kind: 'local',
    repository: directory,
  });
  await act('publishRuntimeDefinition', {
    projectId: project.id,
    baseVersion: 0,
    definition: {
      id: 'document-fixture',
      name: 'Document fixture',
      image: process.env.CONVOY_RUNTIME_TEST_IMAGE,
      sourceCommit: head,
      fixtureDigest: 'a'.repeat(64),
      startup: [],
      readiness: ['/bin/true'],
      guidance: 'Run a conversion check and capture its output in scratch.',
      limits: {
        memoryMb: 128,
        scratchMb: 32,
        cpus: 0.5,
        pids: 32,
        lifetimeSeconds: 120,
        startupSeconds: 10,
        commandSeconds: 20,
      },
    },
  });
  const profile = await act('publishProfile', {
    id: 'verification-test',
    name: 'Verification',
    tools: ['convoy.shell', 'convoy.read_file', 'convoy.write_file'],
    skills: [],
  });
  await act('saveWorkflow', {
    workflow: {
      id: 'verify-document',
      name: 'Verify document',
      runtime: { id: 'document-fixture', version: 1, required: true },
      capabilityProfile: { id: profile.id, version: profile.version },
      nodes: [
        {
          id: 'verify',
          name: 'Verify',
          kind: 'agent',
          permissions: 'full',
          prompt: 'Validate the fixture and capture the result.',
          maxRounds: 6,
          submissionRequirements: { success: { fields: ['basis'], minReferences: 1 } },
        },
        { id: 'review', name: 'Review', kind: 'human', prompt: 'Review evidence' },
      ],
      edges: [{ from: 'verify', to: 'review', outcome: 'success' }],
    },
  });
  const ticket = await act('createTicket', {
    projectId: project.id,
    title: 'Verify document rendering',
    requestId: 'ticket',
  });
  const updated = await act('setExecutionProfile', {
    taskId: ticket.id,
    revision: ticket.revision,
    profile: 'verify',
  });
  const run = await act('runTicket', {
    ticketId: ticket.id,
    revision: updated.revision,
    mode: 'new',
    workflowId: 'verify-document',
    workflowVersion: 1,
    model: 'fixture',
    placement: { mode: 'pinned', runnerId: runner.id },
    requestId: 'run',
  });
  let session;
  for (let i = 0; i < 1200; i++) {
    session = (await runtime.snapshot(run.sessionId)).sessions[0];
    if (
      !session.control.busy &&
      ['waiting_gate', 'failed', 'awaiting_submission'].includes(session.status)
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(session.status, 'waiting_gate', JSON.stringify(session.events.slice(-12)));
  assert.deepEqual(
    session.events.filter((e) => e.type === 'tool_result' && e.isError),
    [],
    'Every successful runner command must reach the model as success',
  );
  assert.equal(round, 2);
  assert.equal(session.flow.lastSubmission.verification.state, 'sealed');
  assert.equal(session.flow.lastSubmission.verification.receipts.length, 1);
  assert.equal(session.flow.lastSubmission.verification.receipts[0].code, 0);
  assert.equal(session.flow.lastSubmission.artifacts.length, 2);
  const responseArtifact = session.flow.lastSubmission.artifacts.find(a => a.path === 'scratch/response.json');
  assert.equal(responseArtifact.size, Buffer.byteLength(responseEvidence));
  assert.equal(responseArtifact.hash, createHash('sha256').update(responseEvidence).digest('hex'));
  await act('claim', { sessionId: run.sessionId });
  await assert.rejects(
    act('resetVerificationRuntime', {
      sessionId: run.sessionId,
      runtimeId: session.flow.lastSubmission.verification.id,
      generation: 1,
    }),
    /pending review/,
  );
  await act('approveGate', { sessionId: run.sessionId, instance: session.flow.instance });
  assert.equal((await runtime.snapshot(run.sessionId)).sessions[0].status, 'accepted');
});
