import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function waitFor(read, predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const value = await read();
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

test('an active provider-only agent starts before a later check needs repository resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-active-resources-'));
  let runtime;
  const providerRequests = [];
  const runnerRequests = [];
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (request) {
      providerRequests.push(structuredClone(request.prompt));
      yield {
        type: 'result',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: 'submit-provider-assessment', name: 'submit_step',
            arguments: { summary: 'Provider assessment started and completed.', artifacts: [], outcome: 'success' },
          }],
          stopReason: 'stop', timestamp: Date.now(),
        },
      };
    },
    runners: {
      async execute(runner, request) {
        runnerRequests.push({ runnerId: runner?.id ?? null, action: request?.action });
        return { code: 0, stdout: '', stderr: '', startedAt: Date.now(), endedAt: Date.now() };
      },
      async close() {},
    },
  };
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime(options);
  const command = (action, input = {}) => runtime.command({
    action, client: 'workflow-active-resources-acceptance', ...input,
  });

  const projectId = 'agent-platform';
  await command('selectActiveContext', { context: { organizationId: 'personal', projectId } });
  const initial = await runtime.snapshot(undefined, 'workflow-active-resources-acceptance');
  const project = initial.projects.find(value => value.id === projectId);
  assert.equal(project.placement.mode, 'none', 'the configured project must not select a runner');

  await command('saveWorkflow', {
    projectId,
    workflow: {
      id: 'provider-before-repository',
      name: 'Provider before repository verification',
      nodes: [
        {
          id: 'assess', kind: 'agent', name: 'Assess request', model: 'fixture',
          prompt: 'Assess the request and submit a concise result.', permissions: 'none', maxRounds: 1,
        },
        {
          id: 'verify', kind: 'check', name: 'Verify repository state',
          prompt: 'Run the configured repository verification.', checkCommand: 'npm test',
        },
      ],
      edges: [{ from: 'assess', to: 'verify', outcome: 'success' }],
    },
  });

  const { workflowRunId } = await command('startWorkflowRun', {
    projectId, workflowId: 'provider-before-repository', workflowVersion: 1,
  });
  const run = await waitFor(
    () => command('getWorkflowRun', { workflowRunId }),
    value => value.nodeId === 'verify' && (value.status !== 'running' || runnerRequests.length > 0),
    'Workflow did not settle at the later repository node',
  );

  assert.equal(providerRequests.length, 1, JSON.stringify({ run, runnerRequests }));
  assert.equal(run.nodeId, 'verify', JSON.stringify(run));
  assert.equal(run.status, 'ready', 'the later repository node should wait for its own resource boundary');
  assert.equal(runnerRequests.length, 0, 'future repository requirements must not dispatch a runner during the provider-only node');

  const after = await runtime.snapshot(undefined, 'workflow-active-resources-acceptance');
  assert.equal(after.workflowRuns.find(value => value.id === workflowRunId).nodeId, 'verify');
  assert.equal(after.sessions.length, 1, 'the agent session is created only when the agent node becomes active');
  assert.equal(after.runners.length, 0);
  assert.equal(after.sessions[0].runnerId, undefined);
  assert.equal(after.sessions[0].workspace, null);
  assert.equal(after.sessions[0].placement.mode, 'none');
});
