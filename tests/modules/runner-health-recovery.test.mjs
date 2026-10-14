import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement } from '../../apps/daemon/src/modules/execution/placement.mjs';
function fixture(probe = async () => ({ tools: ['read_file'], verification: true })) {
  let clock = Date.now();
  const runner = { id: 'research-runner', kind: 'local', organizationId: 'org', environmentId: 'lab', repository: '/research', enabled: true, online: false, checkedAt: new Date(clock - 120000).toISOString(), projectIds: ['study'], tags: [], maxConcurrent: 4, capabilities: { tools: ['read_file'], verification: false } };
  const project = { id: 'study', organizationId: 'org', placement: { mode: 'pinned', runnerId: runner.id } };
  const state = { runners: [runner], projects: [project], sessions: {}, environmentAccessBindings: [], environments: [{ id: 'lab', organizationId: 'org', enabled: true, maxConcurrent: 4, tags: [] }] };
  const calls = [];
  const placement = createPlacement({ state, now: () => clock, save: async () => {}, catalog: { project: () => project, ticket: () => undefined }, workExecution: {}, event: () => {}, access: { migrateProjectBinding: () => {}, authorize: () => ({ allowed: true }) }, capacity: { satisfy: async () => {}, recordDemand: async () => {} }, policy: { selected: () => 'verify', supports: r => r.capabilities?.verification === true, resolve: () => ({ profileId: 'verify', digest: 'pinned-policy' }) }, execute: async (r, request) => { calls.push({ runnerId: r.id, action: request.action }); return request.action === 'probe' ? probe() : request.action === 'provision' ? { path: '/research/isolated', branch: 'study' } : {}; } });
  return { state, runner, placement, calls, session: id => { const s = { id, projectId: project.id, organizationId: 'org', independentRun: true }; state.sessions[id] = s; return s; }, advance: ms => { clock += ms; } };
}
test('queued placement rechecks a stale offline runner and resumes only after confirmed capabilities', async () => {
  const f = fixture(); const s = f.session('study-run'); await f.placement.prepare(s);
  assert.equal(f.calls.filter(c => c.action === 'probe').length, 1); assert.equal(s.assignment.state, 'running'); assert.equal(f.runner.online, true);
});
test('failed recovery preserves its reason and backs off across repeated queue ticks', async () => {
  const f = fixture(async () => { throw new Error('Verification runtime unavailable'); }); const s = f.session('study-run');
  await f.placement.prepare(s); assert.equal(f.calls.length, 1); assert.match(f.runner.health.lastError, /Verification runtime unavailable/); assert.equal(f.runner.health.failureCount, 1);
  await f.placement.prepare(s); assert.equal(f.calls.length, 1);
  f.advance(30000); await f.placement.prepare(s); assert.equal(f.calls.length, 2);
  f.advance(30000); await f.placement.prepare(s); assert.equal(f.calls.length, 2);
  f.advance(30000); await f.placement.prepare(s); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.some(c => c.action === 'provision'), false);
});
test('a reachable runner with missing capabilities is retried without bypassing enforcement', async () => {
  let ready = false; const f = fixture(async () => ({ tools: ['read_file'], verification: ready })); f.runner.online = true;
  const s = f.session('study-run'); await f.placement.prepare(s); assert.equal(f.calls.length, 1); assert.equal(s.workspace, undefined);
  ready = true; f.advance(30000); await f.placement.prepare(s); assert.equal(s.assignment.state, 'running'); assert.equal(f.calls.filter(c => c.action === 'probe').length, 2);
});
test('health recovery never probes disabled, drained, unauthorized or uncertain assignments', async () => {
  for (const kind of ['disabled', 'drained', 'wrong-project', 'wrong-org', 'uncertain', 'outbound', 'revoked']) {
    const f = fixture(); const s = f.session(kind);
    if (kind === 'disabled') f.runner.enabled = false;
    if (kind === 'drained') f.runner.draining = true;
    if (kind === 'wrong-project') f.runner.projectIds = [];
    if (kind === 'wrong-org') f.runner.organizationId = 'other';
    if (kind === 'outbound') f.runner.registration = 'outbound';
    if (kind === 'revoked') f.runner.machineIdentity = { state: 'revoked' };
    if (kind === 'uncertain') s.assignment = { state: 'uncertain', runnerId: f.runner.id };
    await f.placement.prepare(s); assert.equal(f.calls.length, 0, kind);
  }
});
test('concurrent sessions share one health probe and recover their original pinned runner', async () => {
  let finish; const waiting = new Promise(resolve => { finish = resolve; }); const f = fixture(async () => { await waiting; return { tools: ['read_file'], verification: true }; });
  const one = f.session('one'); const two = f.session('two'); one.workspace = { path: '/research/original' }; one.runnerId = f.runner.id;
  const first = f.placement.prepare(one); const second = f.placement.prepare(two); await new Promise(resolve => setImmediate(resolve)); finish(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(c => c.action === 'probe').length, 1); assert.equal(one.runnerId, f.runner.id); assert.equal(one.workspace.path, '/research/original');
});
