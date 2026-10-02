import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const schema = { type: 'object', properties: { amount: { type: 'number', minimum: 0, maximum: 100 } }, required: ['amount'], additionalProperties: false };
async function until(read, predicate) {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Runner activity did not settle: ${JSON.stringify(await read())}`);
}

for (const kind of ['local', 'ssh', null]) {
  const configured = Boolean(kind);
  test(`a no-agent workflow acquires runner resources only at its active activity (${kind ? `${kind} runner` : 'no placement'})`, { timeout: 15000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-runner-activity-'));
    const requests = [];
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let entered = false;
    let runtime;
    t.after(async () => { release(); await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
    runtime = await createRuntime({
      directory, models: [{ id: 'fixture' }],
      auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
      generate: async function* () { assert.fail('Runner-only workflows must not invoke a provider.'); },
      runners: {
        async execute(runner, command) {
          requests.push({ runnerId: runner?.id, action: command.action });
          if (command.action === 'probe') return { repository: '/fixture', tools: ['read_file'], shell: false };
          if (command.action === 'provision') return { path: '/fixture/isolated-run', branch: 'isolated-run' };
          if (command.action === 'diff') return { digest: 'runner-only-evidence', changedFiles: ['record.json'] };
          if (command.action === 'remove') return {};
          assert.fail(`Unexpected runner command ${command.action}`);
        },
        async close() {},
      },
      workflowActivities: [{
        descriptor: {
          ref: { id: 'inventory.normalize-count', revision: 1 }, inputSchema: schema, outputSchema: schema,
          resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
          cancellation: 'immediate', confirmation: 'result', reconciliation: 'none',
          presentation: { label: 'Normalize count' },
        },
        implementation: {
          async prepare(input) { return { amount: input.amount }; },
          async dispatch(_context, input) { entered = true; await barrier; return { state: 'completed', output: { amount: input.amount } }; },
        },
      }],
    });
    const client = 'runner-activity-acceptance';
    const act = (action, values = {}) => runtime.command({ action, client, ...values });
    const project = await act('saveProject', { name: configured ? 'Inventory reconciliation' : 'Document preparation' });
    await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    if (configured) {
      await act('registerRunner', { name: 'Configured verification runner', kind, repository: '/fixture', ...(kind === 'ssh' ? { host: 'fixture.example' } : {}) });
      const runner = (await runtime.snapshot(undefined, client)).runners[0];
      await act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
    }
    requests.length = 0;
    await act('saveWorkflow', { projectId: project.id, workflow: {
      id: 'normalize-then-observe', name: 'Normalize then observe',
      nodes: [
        { id: 'normalize', kind: 'action', name: 'Normalize', activity: { id: 'inventory.normalize-count', revision: 1 }, bindings: { amount: { literal: 12 } } },
        { id: 'observe', kind: 'action', name: 'Observe records', activity: { id: 'runner.inspect-changes', revision: 1 }, bindings: {} },
      ], edges: [{ from: 'normalize', to: 'observe', outcome: 'success' }],
    } });
    const { workflowRunId } = await act('startWorkflowRun', { projectId: project.id, workflowId: 'normalize-then-observe', workflowVersion: 1 });
    await until(() => ({ entered }), value => value.entered);
    assert.equal(requests.length, 0, 'future runner requirements must not dispatch resources during the pure node');
    assert.equal((await runtime.snapshot(undefined, client)).sessions.length, 0);
    release();
    const run = await until(() => act('getWorkflowRun', { workflowRunId }), value =>
      configured ? value.status === 'completed' : value.nodeId === 'observe' && ['paused', 'ready'].includes(value.status));
    const snapshot = await runtime.snapshot(undefined, client);
    assert.equal(snapshot.sessions.length, 0, 'runner resource acquisition must not manufacture an agent session');
    if (configured) {
      assert.equal(run.status, 'completed');
      assert.equal(requests.filter(value => value.action === 'provision').length, 1);
      assert.equal(requests.filter(value => value.action === 'diff').length, 1);
      assert.ok(run.activityAttempts.some(value => value.nodeId === 'observe' && value.status === 'completed' && value.outputDigest));
    } else {
      assert.equal(requests.length, 0);
      assert.equal(run.nodeId, 'observe');
      assert.ok(['paused', 'ready'].includes(run.status), JSON.stringify(run));
      assert.equal(run.activityAttempts.find(value => value.nodeId === 'normalize').status, 'completed');
    }
  });
}


test('a runner-only check uses the configured execution policy without an agent session', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-runner-check-'));
  const requests = [];
  let runtime;
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  runtime = await createRuntime({
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('A runner-only check must not invoke a provider.'); },
    runners: {
      async execute(runner, command) {
        requests.push(structuredClone(command));
        if (command.action === 'probe') return { repository: '/fixture', tools: ['shell'], shell: true, inspection: true, executionDescriptorVersion: 1 };
        if (command.action === 'provision') return { path: '/fixture/check-run', branch: 'check-run' };
        if (command.action === 'diff') return { digest: 'checked-records', changedFiles: [] };
        if (command.action === 'remove') return {};
        if (command.action === 'bind_execution') { assert.equal(command.binding.profileId, 'inspect'); return {}; }
        if (command.action === 'tool' && command.name === 'shell') {
          assert.equal(command.args.command, 'ls');
          assert.equal(command.execution.grant.profileId, 'inspect');
          assert.equal(command.execution.grant.envelope.network.mode, 'none');
          assert.equal(command.execution.workspace, '/fixture/check-run');
          const bound = requests.find(value => value.action === 'bind_execution').binding;
          assert.equal(command.execution.assignmentToken, bound.assignmentToken);
          assert.equal(command.execution.policyDigest, bound.policyDigest);
          return { code: 0, stdout: 'record.json', stderr: '', startedAt: Date.now(), endedAt: Date.now() };
        }
        assert.fail(`Unexpected runner request ${JSON.stringify(command)}`);
      },
      async close() {},
    },
  });
  const client = 'runner-check-acceptance';
  const act = (action, values = {}) => runtime.command({ action, client, ...values });
  let project = await act('saveProject', { name: 'Document validation' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  await act('registerRunner', { name: 'Document checker', kind: 'local', repository: '/fixture' });
  const runner = (await runtime.snapshot(undefined, client)).runners[0];
  project = await act('setPlacement', { projectId: project.id, revision: project.revision, placement: { mode: 'pinned', runnerId: runner.id } });
  await act('setExecutionProfile', { projectId: project.id, revision: project.revision, profile: 'inspect' });
  await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'validate-documents', name: 'Validate documents',
    nodes: [{ id: 'check', kind: 'check', name: 'Inspect documents', prompt: 'Inspect documents', checkCommand: 'ls' }], edges: [],
  } });
  const { workflowRunId } = await act('startWorkflowRun', { projectId: project.id, workflowId: 'validate-documents', workflowVersion: 1 });
  const run = await until(() => act('getWorkflowRun', { workflowRunId }), value => ['completed', 'failed'].includes(value.status));
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(requests.filter(value => value.action === 'tool' && value.name === 'shell').length, 1);
  assert.equal((await runtime.snapshot(undefined, client)).sessions.length, 0);
});
