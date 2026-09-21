import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
const message = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Done' }],
  timestamp: Date.now(),
  stopReason: 'stop',
};
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-placement-test-'));
  const calls = [];
  const releases = [];
  const options = {
    directory,
    models: [{ id: 'test' }],
    auth: { token: async () => 'fake', status: async () => ({ connected: true }) },
    generate: async function* ({ signal }) {
      await new Promise((resolve) => {
        releases.push(resolve);
        signal.addEventListener('abort', resolve, { once: true });
      });
      yield { type: 'result', message };
    },
    runners: {
      execute: async (r, request) => {
        calls.push({ runnerId: r.id, ...request });
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
        if (request.action === 'diff') return { digest: 'same' };
        return { text: 'Content', code: 0 };
      },
    },
    ...overrides,
  };
  const runtime = await createRuntime(options);
  const act = (action, extra = {}) =>
    runtime.command({ action, client: 'test-scheduler', ...extra });
  const snapshot = () => runtime.snapshot();
  async function addRunner(name, environmentId) {
    if (!environmentId)
      environmentId = (
        await act('saveEnvironment', { name, kind: 'ssh', host: name, maxConcurrent: 1 })
      ).id;
    await act('registerRunner', {
      name,
      environmentId,
      repository: '/fixture',
      projectIds: ['agent-platform'],
    });
    const r = (await snapshot()).runners.at(-1);
    await act('updateRunner', { ...r, runnerId: r.id, maxConcurrent: 1 });
    return (await snapshot()).runners.at(-1);
  }
  async function ticket(title) {
    const t = await act('createTicket', {
      title,
      projectId: 'agent-platform',
      requestId: title.replaceAll(' ', '-'),
    });
    await act('ensure', { taskId: t.id, title: 'stale client title' });
    await act('claim', { taskId: t.id, label: 'Test' });
    return t;
  }
  const start = (t) =>
    act('start', { taskId: t.id, text: t.title, requestId: 'run-' + t.id, model: 'test' });
  return { runtime, act, snapshot, addRunner, ticket, start, releases, calls, options };
}
test('central tickets are idempotent, conflict checked, canonical for chat and durable across restart', async () => {
  const f = await fixture();
  const t = await f.ticket('Canonical title');
  const duplicate = await f.act('createTicket', {
    title: 'Different',
    projectId: 'agent-platform',
    requestId: 'Canonical-title',
  });
  assert.equal(duplicate.id, t.id);
  assert.equal((await f.snapshot()).sessions[0].title, 'Canonical title');
  await f.act('updateTicket', {
    taskId: t.id,
    revision: 1,
    patch: { description: 'Shared specification', status: 'Ready' },
  });
  await assert.rejects(
    f.act('updateTicket', { taskId: t.id, revision: 1, patch: { title: 'Stale' } }),
    /another client/,
  );
  const imported = await f.act('importTickets', {
    projectId: 'agent-platform',
    tickets: [
      { id: t.id, title: 'Overwrite' },
      { id: 20, title: 'Browser draft' },
    ],
  });
  assert.deepEqual(imported.conflicts, [t.id]);
  assert.equal(imported.imported, 1);
  await f.runtime.close();
  const restarted = await createRuntime(f.options);
  const state = await restarted.snapshot();
  assert.equal(state.tickets[0].description, 'Shared specification');
  assert.equal(state.sessions[0].description, 'Shared specification');
  assert.equal(state.tickets.length, 2);
  await restarted.close();
});
test('pool balances across environments, respects aggregate capacity and dispatches queued work when slots free', async () => {
  const f = await fixture();
  const a = await f.addRunner('host-a');
  const aa = await f.addRunner('host-a-second', a.environmentId);
  const b = await f.addRunner('host-b');
  const pool = await f.act('saveRunnerPool', { name: 'Balanced', runnerIds: [a.id, aa.id, b.id] });
  await f.act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id },
  });
  await f.act('setScheduler', { maxConcurrent: 8 });
  const first = await f.ticket('first');
  const second = await f.ticket('second');
  const third = await f.ticket('third');
  await f.start(first);
  await until(() => f.releases.length === 1);
  await f.start(second);
  await until(() => f.releases.length === 2);
  await f.start(third);
  await until(
    async () =>
      (await f.snapshot()).sessions.find((s) => s.id === String(third.id)).status === 'queued',
  );
  let state = await f.snapshot();
  assert.equal(state.sessions[0].runnerId, a.id);
  assert.equal(state.sessions[1].runnerId, b.id);
  assert.equal(state.environments.find((e) => e.id === a.environmentId).load, 1);
  assert.equal(f.calls.filter((c) => c.action === 'provision').length, 2);
  f.releases[0]();
  await until(() => f.releases.length === 3);
  state = await f.snapshot();
  assert.equal(state.sessions[2].assignment.environmentId, a.environmentId);
  await f.runtime.close();
});
test('organization policy ask cannot be satisfied by selecting full-access-ask', async () => {
  const f = await fixture();
  let runner = await f.addRunner('trusted-policy-host');
  await f.act('updateRunner', { ...runner, runnerId: runner.id, accessMode: 'trusted' });
  runner = (await f.snapshot()).runners.find((value) => value.id === runner.id);
  const pool = await f.act('saveRunnerPool', {
    name: 'Trusted policy pool',
    runnerIds: [runner.id],
  });
  await f.act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id },
  });
  await f.act('setExecutionProfile', {
    projectId: 'agent-platform',
    revision: 2,
    profile: 'full-access-ask',
  });
  await f.act('saveOrganizationPolicy', {
    organizationId: 'personal',
    scope: { kind: 'organization', organizationId: 'personal' },
    rules: { fullSystemAccess: 'ask' },
    baseRevision: 0,
  });
  const ticket = await f.ticket('full access policy ask');
  await f.start(ticket);
  await until(async () => (await f.snapshot()).sessions[0].status === 'queued');
  assert.match((await f.snapshot()).sessions[0].queueReason, /Organization policy/);
  assert.equal(f.calls.filter((call) => call.action === 'provision').length, 0);
  await f.runtime.close();
});
test('project restrictions and capability labels fail closed; policy edits can reroute queued unbound work', async () => {
  const f = await fixture();
  const r = await f.addRunner('restricted-host');
  await f.act('updateRunner', { ...r, runnerId: r.id, projectIds: [] });
  const pool = await f.act('saveRunnerPool', { name: 'Restricted', runnerIds: [r.id] });
  await f.act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id },
  });
  const t = await f.ticket('restricted');
  await f.start(t);
  await until(async () => (await f.snapshot()).sessions[0].status === 'queued');
  assert.equal(f.releases.length, 0);
  assert.equal(f.calls.filter((c) => c.action === 'provision').length, 0);
  await until(async () => {
    try {
      await f.act('setPlacement', {
        taskId: t.id,
        revision: t.revision,
        placement: { mode: 'none' },
      });
      return true;
    } catch (e) {
      if (!/Cancel or finish/.test(e.message)) throw e;
    }
  });
  await until(() => f.releases.length === 1);
  assert.equal((await f.snapshot()).sessions[0].workspace, null);
  await f.runtime.close();
});
test('uncertain provisioning never falls back to a second host and reconciliation needs exact assignment confirmation', async () => {
  const f = await fixture();
  const a = await f.addRunner('host-a');
  const b = await f.addRunner('host-b');
  const pool = await f.act('saveRunnerPool', { name: 'Pool', runnerIds: [a.id, b.id] });
  await f.act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id },
  });
  const original = f.options.runners.execute;
  f.options.runners.execute = async (r, request) => {
    if (request.action === 'provision')
      throw new Error('Disconnected after remote creation may have started');
    return original(r, request);
  };
  const t = await f.ticket('uncertain');
  await f.start(t);
  await until(async () => {
    const s = (await f.snapshot()).sessions[0];
    return s.status === 'failed' && !s.control.busy;
  });
  const s = (await f.snapshot()).sessions[0];
  assert.equal(s.assignment.state, 'uncertain');
  assert.equal(s.runnerId, a.id);
  assert.ok(s.workspaceRequest);
  await assert.rejects(
    f.act('setPlacement', {
      taskId: t.id,
      revision: t.revision,
      placement: { mode: 'pinned', runnerId: b.id },
    }),
    /pinned/,
  );
  await assert.rejects(
    f.act('reconcileAssignment', { taskId: t.id, token: 'wrong', confirmStopped: true }),
    /exact/,
  );
  await f.act('reconcileAssignment', {
    taskId: t.id,
    token: s.assignment.token,
    confirmStopped: true,
  });
  assert.equal((await f.snapshot()).sessions[0].assignment.state, 'released');
  await f.runtime.close();
});
test('restart retains uncertain reservations even if execution completed before release was persisted', async () => {
  const f = await fixture();
  const r = await f.addRunner('host-a');
  const t = await f.ticket('restart');
  await f.runtime.close();
  const path = join(f.options.directory, 'state.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  const s = data.sessions[String(t.id)];
  s.status = 'awaiting_review';
  s.assignment = {
    token: 'attempt',
    runnerId: r.id,
    environmentId: r.environmentId,
    state: 'running',
  };
  await writeFile(path, JSON.stringify(data));
  const restarted = await createRuntime(f.options);
  const state = await restarted.snapshot();
  assert.equal(state.sessions[0].assignment.state, 'uncertain');
  assert.equal(state.environments[0].load, 1);
  assert.equal(f.releases.length, 0);
  await restarted.close();
});

test('project instructions do not leak between projects', async () => {
  const f = await fixture();
  await f.act('publishInstruction', {
    scope: 'project',
    name: 'AGENTS.md',
    content: 'First project only',
  });
  const p = await f.act('saveProject', { name: 'Other project', description: '' });
  const t = await f.act('createTicket', {
    projectId: p.id,
    title: 'Other task',
    requestId: 'other-task',
  });
  await f.act('ensure', { taskId: t.id, title: t.title });
  await f.act('claim', { taskId: t.id, label: 'Test' });
  await f.act('configure', { taskId: t.id });
  assert.equal((await f.snapshot()).sessions[0].instructions.length, 0);
  await f.act('publishInstruction', {
    projectId: p.id,
    scope: 'project',
    name: 'AGENTS.md',
    content: 'Other project only',
  });
  await f.act('configure', { taskId: t.id });
  assert.equal((await f.snapshot()).sessions[0].instructions[0].content, 'Other project only');
  await f.runtime.close();
});

test('required tools and labels prevent incompatible dispatch', async () => {
  const f = await fixture();
  const r = await f.addRunner('host-labels');
  const pool = await f.act('saveRunnerPool', { name: 'Label pool', runnerIds: [r.id] });
  await f.act('setPlacement', {
    projectId: 'agent-platform',
    revision: 1,
    placement: { mode: 'pool', poolId: pool.id, requiredTags: ['gpu'], requiredTools: ['shell'] },
  });
  const t = await f.ticket('requires-gpu');
  await f.start(t);
  await until(async () => (await f.snapshot()).sessions[0].status === 'queued');
  assert.equal(f.releases.length, 0);
  await f.act('updateRunner', { ...r, runnerId: r.id, tags: ['gpu'] });
  await until(() => f.releases.length === 1);
  await f.runtime.close();
});
