import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

const callback = {
  id: 'publication.callback', revision: 1, label: 'Publication callback',
  source: { owner: 'publication-adapter' }, tenantScope: 'project',
  payload: [
    { path: 'requestId', type: 'string', required: true },
    { path: 'status', type: 'enum', values: ['published', 'rejected'], required: true },
  ], correlationPaths: ['requestId'], maxPayloadBytes: 4096, manual: true,
};
const organizationSignal = {
  id: 'publication.organization_signal', revision: 1, label: 'Organization signal',
  source: { owner: 'publication-adapter' }, tenantScope: 'organization',
  payload: [{ path: 'requestId', type: 'string', required: true }, { path: 'status', type: 'string', required: true }],
  correlationPaths: ['requestId'], maxPayloadBytes: 4096, manual: true,
};
const inventory = {
  ref: { id: 'inventory.snapshot', revision: 1 },
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  outputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false },
  resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
  cancellation: 'immediate', confirmation: 'result', reconciliation: 'none',
  presentation: { label: 'Inventory snapshot' },
};

async function until(read, message = 'Acceptance condition did not become true') {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function fixture(t, { workflowActivities = [], workflowEvents = [callback], clock = () => Date.now() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-events-'));
  const options = {
    directory, models: [{ id: 'fixture' }], clock, workflowEvents, workflowActivities,
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('The no-agent event examples must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('The no-runner event examples must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input = {}, principal) => runtime.command({ action, client: 'workflow-events-test', ...input }, principal);
  const project = await act('saveProject', { name: 'Publication' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  return {
    directory, options, act, project, runtime: () => runtime,
    snapshot: (...args) => runtime.snapshot(undefined, 'workflow-events-test', ...args),
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
  };
}

test('manual event submission binds tenant and principal, deduplicates, and starts through the run engine', async t => {
  const f = await fixture(t);
  const second = await f.act('saveProject', { name: 'Procurement' });
  const published = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'publication-review', name: 'Publication review',
    nodes: [{ id: 'review', name: 'Review callback', kind: 'human', prompt: 'Review the publication result.' }], edges: [],
  } });
  await f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Review published callbacks', projectId: f.project.id,
    when: { event: callback.id, eventRevision: callback.revision },
    if: [{ path: 'status', operator: 'equals', value: 'published' }],
    then: { action: 'start_workflow', workflowId: published.id, workflowVersion: published.version },
    concurrency: { policy: 'independent', maxActiveRuns: 5 }, enabled: true,
  }, revision: 0 });
  const payload = { requestId: 'publication-42', status: 'published' };
  await assert.rejects(f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'callback-42', payload: { ...payload, projectId: second.id } }), /not registered/i);
  const first = await f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'callback-42', payload });
  const duplicate = await f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'callback-42', payload });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const acceptedState = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.values(acceptedState.automationDecisionLedger).at(-1)?.status, 'started');
  const run = await until(async () => {
    const summary = (await f.snapshot()).workflowRuns[0];
    if (!summary) return null;
    const current = await f.act('getWorkflowRun', { workflowRunId: summary.id });
    return current?.status === 'waiting_gate' ? current : null;
  });
  assert.equal(run.projectId, f.project.id);
  const decision = Object.values(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).automationDecisionLedger)[0];
  assert.equal(decision.subscriptionId, (await f.snapshot()).automations[0].id);
  assert.equal((await f.snapshot()).sessions.length, 0);
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: second.id } });
  await assert.rejects(f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'callback-42', payload }), /conflicts/i);
  const isolated = await f.snapshot();
  assert.equal(isolated.workflowRuns.length, 1, 'the second-project identity conflict must not append or replace the original decision/run');
  assert.equal(isolated.sessions.length, 0);
});

test('durable interval schedule coalesces missed slots and starts one no-agent inventory run', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const calls = [];
  const registration = { descriptor: inventory, implementation: {
    async prepare(context) { assert.equal(context.session, null); return { count: 1 }; },
    async dispatch(context) { calls.push(context); return { count: 17 }; },
  } };
  const f = await fixture(t, { workflowActivities: [registration], clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-reconciliation', name: 'Inventory reconciliation',
    nodes: [{ id: 'snapshot', name: 'Snapshot', kind: 'action', activity: inventory.ref, bindings: {} }], edges: [],
  } });
  const schedule = await f.act('saveWorkflowSchedule', {
    name: 'Daily inventory snapshot', projectId: f.project.id, workflowId: workflow.id,
    workflowVersion: workflow.version, schedule: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: 'coalesce_once', enabled: true,
  });
  current += 3 * 60_000 + 1000;
  const tick = await f.runtime().tickWorkflowEvents();
  const run = await until(async () => {
    const value = (await f.snapshot()).workflowRuns[0];
    if (!value) return null;
    const currentRun = await f.act('getWorkflowRun', { workflowRunId: value.id });
    return currentRun.status === 'completed' ? currentRun : null;
  }, `scheduled run did not complete; tick=${JSON.stringify(tick)}; persisted=${JSON.stringify((({ workflowSchedules, workflowScheduleFirings, automationDecisionLedger, workflowRuns }) => ({ workflowSchedules, workflowScheduleFirings, automationDecisionLedger, workflowRuns }))(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'))))}`);
  assert.equal(run.provenance.subscriptionId, schedule.scheduleId);
  assert.equal(run.activityOutputs.snapshot.count, 17);
  assert.equal(calls.length, 1);
  assert.equal((await f.snapshot()).sessions.length, 0);
  await f.restart();
  await f.runtime().tickWorkflowEvents();
  const persisted = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.keys(persisted.workflowRuns).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(Object.values(persisted.workflowScheduleFirings).filter(value => value.status === 'accepted').length, 1);
});

test('webhook ingress requires a service-principal bearer and keeps its configured project scope', async t => {
  const f = await fixture(t);
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'callback-review', name: 'Review publication callback',
    nodes: [{ id: 'review', name: 'Review callback', kind: 'human', prompt: 'Review the callback.' }], edges: [],
  } });
  await f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Review inbound publication callbacks', projectId: f.project.id,
    when: { event: callback.id, eventRevision: callback.revision }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 5 }, enabled: true,
  }, revision: 0 });
  const service = await f.act('createServicePrincipal', { organizationId: 'personal', displayName: 'Publication callback source' });
  const principal = { kind: 'service-principal', servicePrincipalId: service.servicePrincipal.id };
  await f.act('createMembership', { organizationId: 'personal', principal, scope: { kind: 'organization', organizationId: 'personal' }, roles: ['member'] });
  await f.act('createMembership', { organizationId: 'personal', principal, scope: { kind: 'project', projectId: f.project.id }, roles: ['contributor'] });
  const binding = await f.act('saveWorkflowWebhookBinding', { name: 'Publication provider', descriptorId: callback.id,
    descriptorRevision: callback.revision, projectId: f.project.id, servicePrincipalId: principal.servicePrincipalId,
    eventIdPath: 'eventId', fieldMap: [{ targetPath: 'requestId', sourcePath: 'requestId' }, { targetPath: 'status', sourcePath: 'status' }], enabled: true });
  const app = createApp({ runtime: f.runtime(), auth: {}, identitySessions: f.runtime().identitySessions,
    access: { host: /^127\.0\.0\.1:\d+$/, origin: /^http:\/\/127\.0\.0\.1:\d+$/ } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const url = `http://127.0.0.1:${app.address().port}/api/workflow-events/${binding.bindingId}`;
  const payload = { eventId: 'provider-event-1', requestId: 'publication-77', status: 'published', projectId: 'foreign-project' };
  const cookieOnly = await fetch(url, { method: 'POST', headers: { Host: `127.0.0.1:${app.address().port}`,
    'Content-Type': 'application/json', Cookie: `convoy_session=${service.credential}` }, body: JSON.stringify(payload) });
  assert.ok(cookieOnly.status >= 400 && cookieOnly.status < 500);
  const headers = { Host: `127.0.0.1:${app.address().port}`, Authorization: `Bearer ${service.credential}`, 'Content-Type': 'application/json' };
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(accepted.status, 200);
  const duplicate = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const run = await until(async () => {
    const summary = (await f.snapshot()).workflowRuns[0];
    if (!summary) return null;
    const current = await f.act('getWorkflowRun', { workflowRunId: summary.id });
    return current.status === 'waiting_gate' ? current : null;
  });
  assert.equal(run.projectId, f.project.id);
  assert.equal((await f.snapshot()).sessions.length, 0);
  const stored = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(stored.workflowEventJournal[0].projectId, f.project.id);
  assert.equal(stored.workflowEventJournal[0].payload.projectId, undefined);
  await f.act('revokeWorkflowWebhookBinding', { id: binding.bindingId, revision: binding.revision });
  const revoked = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(revoked.status, 403);
  assert.equal((await f.snapshot()).workflowRuns.length, 1);
});

test('correlated waits resume only for the pinned scope and exact organization', async t => {
  const f = await fixture(t, { workflowEvents: [callback, organizationSignal] });
  const foreign = await f.act('createOrganization', { slug: `event-foreign-${Date.now()}`, displayName: 'Foreign events', kind: 'team' });
  const foreignProject = await f.act('saveProject', { organizationId: foreign.id, name: 'Other publication' });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'publication-wait', name: 'Wait for publication callback',
    runInputSchema: { type: 'object', properties: { requestId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['requestId'], additionalProperties: false },
    nodes: [{ id: 'callback', name: 'Callback', kind: 'wait', waitFor: {
      event: organizationSignal.id, eventRevision: 1, scope: 'organization',
      correlation: { key: 'requestId', from: 'runInput.requestId' },
      if: [{ path: 'status', operator: 'equals', value: 'published' }], timeoutSeconds: 3600,
    } }], edges: [],
  } });
  const subscribedWorkflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'organization-event-review', name: 'Review organization signal',
    nodes: [{ id: 'review', name: 'Review signal', kind: 'human', prompt: 'Review the organization signal.' }], edges: [],
  } });
  await f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Start on organization signal', projectId: f.project.id,
    when: { event: organizationSignal.id, eventRevision: organizationSignal.revision }, if: [],
    then: { action: 'start_workflow', workflowId: subscribedWorkflow.id, workflowVersion: subscribedWorkflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 5 }, enabled: true,
  }, revision: 0 });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { requestId: 'request-organization-1' } });
  const waiting = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(waiting.status, 'waiting_event');
  assert.equal((await f.snapshot()).sessions.length, 0);
  await f.act('selectActiveContext', { context: { organizationId: foreign.id, projectId: foreignProject.id } });
  await f.act('submitWorkflowEvent', { descriptorId: organizationSignal.id, idempotencyKey: 'foreign-event',
    payload: { requestId: 'request-organization-1', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId })).status, 'waiting_event',
    'same correlation in a foreign organization cannot resume the run');
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: f.project.id } });
  await f.act('submitWorkflowEvent', { descriptorId: organizationSignal.id, idempotencyKey: 'local-event',
    payload: { requestId: 'request-organization-1', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  const completed = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(completed.status, 'completed', JSON.stringify((({ workflowWaits, workflowEventJournal }) => ({ workflowWaits, workflowEventJournal }))(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')))));
  const runs = (await f.snapshot()).workflowRuns;
  assert.equal(runs.length, 2, 'wait delivery and start subscriptions both observe the event');
  assert.ok(runs.some(value => value.workflowId === subscribedWorkflow.id && value.status === 'waiting_gate'));
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('correlated project waits keep unrelated publications isolated and timeouts resume after restart', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const f = await fixture(t, { workflowEvents: [callback], clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'callback-wait', name: 'Wait for callback',
    runInputSchema: { type: 'object', properties: { requestId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['requestId'], additionalProperties: false },
    nodes: [{ id: 'callback', name: 'Callback', kind: 'wait', waitFor: {
      event: callback.id, eventRevision: 1, scope: 'project', correlation: { key: 'requestId', from: 'runInput.requestId' },
      if: [{ path: 'status', operator: 'equals', value: 'published' }], timeoutSeconds: 3600,
    } }], edges: [],
  } });
  const timeoutWorkflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'callback-timeout', name: 'Wait for callback timeout',
    runInputSchema: { type: 'object', properties: { requestId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['requestId'], additionalProperties: false },
    nodes: [{ id: 'callback', name: 'Callback', kind: 'wait', waitFor: {
      event: callback.id, eventRevision: 1, scope: 'project', correlation: { key: 'requestId', from: 'runInput.requestId' },
      if: [{ path: 'status', operator: 'equals', value: 'published' }], timeoutSeconds: 60,
    } }], edges: [],
  } });
  const first = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { requestId: 'expected-callback' } });
  await f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'unrelated-correlation', payload: { requestId: 'other-callback', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  const afterUnrelated = await f.act('getWorkflowRun', { workflowRunId: first.workflowRunId });
  assert.equal(afterUnrelated.status, 'waiting_event', JSON.stringify((({ workflowWaits, workflowRuns, workflowEventJournal }) => ({
    wait: Object.values(workflowWaits), run: workflowRuns[first.workflowRunId], events: workflowEventJournal,
  }))(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')))));
  const second = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: timeoutWorkflow.id, workflowVersion: timeoutWorkflow.version,
    runInput: { requestId: 'will-time-out' } });
  await f.restart();
  current += 61_000;
  await f.runtime().tickWorkflowEvents();
  const timedOut = await f.act('getWorkflowRun', { workflowRunId: second.workflowRunId });
  assert.equal(timedOut.status, 'completed');
  assert.equal(timedOut.history.at(-1).outcome, 'timeout');
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: first.workflowRunId })).status, 'waiting_event');
  assert.equal((await f.snapshot()).sessions.length, 0);
});
