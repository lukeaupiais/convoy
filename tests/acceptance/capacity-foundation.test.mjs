import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createDeterministicCapacityAdapter } from '../support/deterministic-capacity.mjs';

const message = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Done' }],
  timestamp: Date.now(),
  stopReason: 'stop',
};

async function until(check) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

test('static capacity exhaustion records demand and never provisions a runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-capacity-'));
  const runnerCalls = [];
  const releases = [];
  const capacityProvider = createDeterministicCapacityAdapter();
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'test' }],
    auth: {
      token: async () => 'fake',
      status: async () => ({ connected: true }),
    },
    capacityProvider,
    generate: async function* ({ signal }) {
      await new Promise((resolve) => {
        releases.push(resolve);
        signal.addEventListener('abort', resolve, { once: true });
      });
      yield { type: 'result', message };
    },
    runners: {
      execute: async (runner, request) => {
        runnerCalls.push({ runnerId: runner.id, ...request });
        if (request.action === 'probe')
          return {
            repository: request.repository,
            tools: ['read_file', 'write_file', 'search_files', 'shell'],
            shell: true,
          };
        if (request.action === 'provision')
          return {
            path: `${request.repository}/${request.workspaceId}`,
            branch: request.workspaceId,
          };
        return { text: '', code: 0 };
      },
    },
  });
  const act = (action, extra = {}) =>
    runtime.command({ action, client: 'capacity-acceptance', ...extra });
  const environment = await act('saveEnvironment', {
    name: 'Fixed inventory',
    kind: 'ssh',
    host: 'fixed-host',
    maxConcurrent: 1,
  });
  await act('registerRunner', {
    name: 'only-runner',
    environmentId: environment.id,
    repository: '/fixture',
    projectIds: ['agent-platform'],
  });
  let snapshot = await runtime.snapshot();
  const runner = snapshot.runners[0];
  await act('updateRunner', {
    ...runner,
    runnerId: runner.id,
    maxConcurrent: 1,
  });
  const pool = await act('saveRunnerPool', { name: 'Fixed pool', runnerIds: [runner.id] });
  await act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id },
  });

  async function start(title) {
    const ticket = await act('createTicket', {
      title,
      projectId: 'agent-platform',
      requestId: title,
    });
    await act('ensure', { taskId: ticket.id, title });
    await act('claim', { taskId: ticket.id, label: 'Capacity test' });
    await act('start', {
      taskId: ticket.id,
      text: title,
      requestId: `run-${ticket.id}`,
      model: 'test',
    });
    return ticket;
  }

  await start('occupy-static-runner');
  await until(() => releases.length === 1);
  const waiting = await start('wait-for-static-runner');
  await until(
    async () =>
      (await runtime.snapshot()).sessions.find((session) => session.id === String(waiting.id))
        ?.status === 'queued',
  );
  snapshot = await runtime.snapshot();

  assert.equal(runnerCalls.filter((call) => call.action === 'provision').length, 1);
  assert.equal(capacityProvider.calls.length, 1);
  assert.equal(snapshot.capacityRequests.length, 1);
  assert.equal(snapshot.capacityRequests[0].state, 'open');
  assert.equal(snapshot.capacityRequests[0].desiredCapacity, 1);
  assert.equal(snapshot.capacityRequests[0].availableCapacity, 0);
  assert.equal(snapshot.capacityRequests[0].organizationId, 'personal');
  assert.equal(snapshot.capacityRequests[0].poolId, pool.id);
  assert.equal(snapshot.capacityStatuses[0].openRequests, 1);

  await runtime.close();
});
