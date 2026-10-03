import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const inventoryEvent = {
  id: 'inventory.reconciled', revision: 1, label: 'Inventory reconciled',
  source: { owner: 'inventory-source' }, tenantScope: 'project', manual: true,
  payload: [{ path: 'count', type: 'number', required: true }],
  correlationPaths: [], maxPayloadBytes: 4096,
};

const publicationRequested = {
  id: 'publication.requested', revision: 1, label: 'Publication requested',
  source: { owner: 'publication-source' }, tenantScope: 'project', manual: true,
  payload: [
    { path: 'document.reference', type: 'string', required: true },
    { path: 'document.status', type: 'enum', values: ['submitted', 'withdrawn'], required: true },
  ],
  correlationPaths: ['document.reference'], maxPayloadBytes: 4096,
};

const publicationReady = {
  id: 'publication.ready', revision: 1, label: 'Publication ready',
  source: { owner: 'publication-source' }, tenantScope: 'project', manual: true,
  payload: [
    { path: 'document.reference', type: 'string', required: true },
    { path: 'document.status', type: 'enum', values: ['published', 'rejected'], required: true },
  ],
  correlationPaths: ['document.reference'], maxPayloadBytes: 4096,
};

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

function transformDescriptor(id, inputSchema, outputSchema) {
  return {
    ref: { id, revision: 1 }, inputSchema, outputSchema,
    resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
    cancellation: 'immediate', confirmation: 'result', reconciliation: 'none',
    presentation: { label: id },
  };
}

async function until(read, predicate, message, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

async function fixture(t, { events, activities = [], clock = () => Date.now() }) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-event-inputs-'));
  const client = `workflow-event-inputs-${Math.random().toString(36).slice(2)}`;
  const options = {
    directory, models: [{ id: 'fixture' }], workflowEvents: events, workflowActivities: activities, clock,
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('These event and schedule examples must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('These daemon activities must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const project = await act('saveProject', { name: 'Event input verification' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  return {
    directory, client, options, project, act,
    runtime: () => runtime,
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
    async state() { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); },
  };
}

test('inventory event bindings pin validated run input through duplicate delivery, restart, and rule edits', async t => {
  const observed = [];
  const descriptor = transformDescriptor('inventory.total-items',
    object({ count: { type: 'number' }, multiplier: { type: 'number' } }),
    object({ total: { type: 'number' } }));
  const f = await fixture(t, {
    events: [inventoryEvent],
    activities: [{ descriptor, implementation: {
      async prepare(input, identity) { return { key: identity.idempotencyKey, input: structuredClone(input) }; },
      async dispatch(context, input) {
        observed.push({ runId: context.run.id, input: structuredClone(input), session: context.session });
        return { state: 'completed', output: { total: input.count * input.multiplier } };
      },
    } }],
  });

  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-total', name: 'Inventory total',
    runInputSchema: object({ count: { type: 'number' }, multiplier: { type: 'number' } }),
    nodes: [{ id: 'total', kind: 'action', name: 'Calculate total', activity: descriptor.ref,
      bindings: {
        count: { from: { kind: 'run_input', path: ['count'] } },
        multiplier: { from: { kind: 'run_input', path: ['multiplier'] } },
      } }], edges: [],
  } });
  const ruleInputBindings = {
    count: { from: { kind: 'event_payload', path: ['count'] } },
    multiplier: { value: 2 },
  };
  const savedRule = await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    name: 'Reconcile inventory count', projectId: f.project.id, enabled: true,
    when: { event: inventoryEvent.id, eventRevision: inventoryEvent.revision }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version, inputBindings: ruleInputBindings },
    concurrency: { policy: 'independent', maxActiveRuns: 5 },
  } });

  await assert.rejects(f.act('saveAutomation', { organizationId: 'personal', revision: savedRule.revision, rule: {
    ...savedRule, then: { ...savedRule.then, inputBindings: {
      count: { from: { kind: 'event_payload', path: ['missing'] } }, multiplier: { value: 2 },
    } },
  } }), /path|declared|binding|input/i, 'undeclared event payload paths must be rejected when saving a rule');
  await assert.rejects(f.act('saveAutomation', { organizationId: 'personal', revision: savedRule.revision, rule: {
    ...savedRule, then: { ...savedRule.then, inputBindings: { count: { from: { kind: 'event_payload', path: ['count'] } } } },
  } }), /required|input|binding/i, 'a required run-input field cannot be omitted from the saved binding map');
  await assert.rejects(f.act('submitWorkflowEvent', { descriptorId: inventoryEvent.id, idempotencyKey: 'inventory-missing-count', payload: {} }), /missing|count/i);
  await assert.rejects(f.act('submitWorkflowEvent', { descriptorId: inventoryEvent.id, idempotencyKey: 'inventory-wrong-count', payload: { count: 'twelve' } }), /type|count/i);
  assert.equal(observed.length, 0, 'invalid data must fail before an activity dispatches');

  const payload = { count: 12 };
  const accepted = await f.act('submitWorkflowEvent', { descriptorId: inventoryEvent.id, idempotencyKey: 'inventory-receipt-12', payload });
  assert.equal(accepted.duplicate, false);
  const run = await until(async () => {
    const current = await f.state();
    const candidate = Object.values(current.workflowRuns ?? {}).find(value => value.provenance?.sourceEventId === 'inventory-receipt-12');
    return candidate?.flow?.status === 'completed' ? candidate : null;
  }, value => value, 'inventory event workflow did not complete');
  assert.deepEqual(observed.map(value => value.input), [{ count: 12, multiplier: 2 }]);
  assert.equal(observed[0].session, null);
  assert.equal(run.activityOutputs.total.value.total, 24);
  const before = await f.state();
  const decision = Object.values(before.automationDecisionLedger).find(value => value.runId === run.id);
  assert.deepEqual(decision.runInput, { count: 12, multiplier: 2 });
  assert.equal(typeof decision.runInputDigest, 'string');
  const originalDecisionKey = decision.decisionKey;
  const originalRunId = decision.runId;
  const originalRunInputDigest = run.runInputDigest;

  const duplicate = await f.act('submitWorkflowEvent', { descriptorId: inventoryEvent.id, idempotencyKey: 'inventory-receipt-12', payload });
  assert.equal(duplicate.duplicate, true);
  await f.restart();
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: f.project.id } });
  await f.runtime().tickWorkflowEvents();
  assert.equal(observed.length, 1, 'restart and exact duplicate delivery must not dispatch a second activity');

  const currentRule = (await f.runtime().snapshot(undefined, f.client)).automations.find(value => value.id === savedRule.id);
  await f.act('saveAutomation', { organizationId: 'personal', revision: currentRule.revision, rule: {
    ...currentRule, then: { ...currentRule.then, inputBindings: {
      count: { from: { kind: 'event_payload', path: ['count'] } }, multiplier: { value: 5 },
    } },
  } });
  await f.act('submitWorkflowEvent', { descriptorId: inventoryEvent.id, idempotencyKey: 'inventory-receipt-8', payload: { count: 8 } });
  await until(async () => observed.length, count => count === 2,
    `revised rule did not process the later event: ${JSON.stringify({ events: (await f.state()).workflowEventJournal, rules: (await f.state()).automations, decisions: Object.values((await f.state()).automationDecisionLedger) })}`);
  assert.deepEqual(observed.map(value => value.input), [{ count: 12, multiplier: 2 }, { count: 8, multiplier: 5 }]);
  const after = await f.state();
  const original = after.automationDecisionLedger[originalDecisionKey];
  assert.equal(original.runId, originalRunId);
  assert.deepEqual(original.runInput, { count: 12, multiplier: 2 });
  assert.equal(after.workflowRuns[originalRunId].runInputDigest, originalRunInputDigest);
  assert.equal((await f.runtime().snapshot(undefined, f.client)).sessions.length, 0);

  const otherProject = await f.act('saveProject', { name: 'Unrelated publication' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: otherProject.id } });
  await assert.rejects(f.act('submitWorkflowEvent', { projectId: f.project.id, descriptorId: inventoryEvent.id,
    idempotencyKey: 'foreign-project-input', payload: { count: 3 } }), /active context|select|project/i);
  assert.equal(observed.length, 2, 'foreign project input must not reach the activity');
});

test('nested publication reference binds a correlated wait without exposing raw event lookup to the activity', async t => {
  const f = await fixture(t, { events: [publicationRequested, publicationReady] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'publication-correlation', name: 'Correlate publication callbacks',
    runInputSchema: object({ reference: { type: 'string' } }),
    nodes: [{ id: 'published', name: 'Wait for publication', kind: 'wait', waitFor: {
      event: publicationReady.id, scope: 'project',
      correlation: { key: 'document.reference', from: 'runInput.reference' },
      if: [{ path: 'document.status', operator: 'equals', value: 'published' }],
    } }], edges: [],
  } });
  await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    name: 'Wait on publication result', projectId: f.project.id, enabled: true,
    when: { event: publicationRequested.id, eventRevision: 1 }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version,
      inputBindings: { reference: { from: { kind: 'event_payload', path: ['document', 'reference'] } } } },
  } });
  await f.act('submitWorkflowEvent', { descriptorId: publicationRequested.id, idempotencyKey: 'publication-request-1',
    payload: { document: { reference: 'release-2026-42', status: 'submitted' } } });
  const waiting = await until(async () => {
    const state = await f.state();
    return Object.values(state.workflowRuns ?? {}).find(value => value.provenance?.sourceEventId === 'publication-request-1');
  }, value => value?.flow?.status === 'waiting_event', 'publication workflow did not enter its correlated wait');
  const acceptedDecision = Object.values((await f.state()).automationDecisionLedger).find(value => value.runId === waiting.id);
  assert.deepEqual(acceptedDecision.runInput, { reference: 'release-2026-42' });

  await f.act('submitWorkflowEvent', { descriptorId: publicationReady.id, idempotencyKey: 'publication-ready-other',
    payload: { document: { reference: 'release-2026-41', status: 'published' } } });
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: waiting.id })).status, 'waiting_event');
  await f.act('submitWorkflowEvent', { descriptorId: publicationReady.id, idempotencyKey: 'publication-ready-match',
    payload: { document: { reference: 'release-2026-42', status: 'published' } } });
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: waiting.id })).status, 'completed');
  assert.equal((await f.runtime().snapshot(undefined, f.client)).sessions.length, 0);
});

test('schedule runInput constants are schema-checked and remain pinned to each immutable schedule revision', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const inputs = [];
  const descriptor = transformDescriptor('inventory.scheduled-count',
    object({ count: { type: 'number' } }), object({ count: { type: 'number' } }));
  const f = await fixture(t, { events: [], clock: () => current,
    activities: [{ descriptor, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(context, input) {
        inputs.push({ runId: context.run.id, input: structuredClone(input), session: context.session });
        return { state: 'completed', output: structuredClone(input) };
      },
    } }],
  });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'scheduled-count', name: 'Scheduled count',
    runInputSchema: object({ count: { type: 'number' } }),
    nodes: [{ id: 'count', kind: 'action', name: 'Capture count', activity: descriptor.ref,
      bindings: { count: { from: { kind: 'run_input', path: ['count'] } } } }], edges: [],
  } });
  const schedule = await f.act('saveWorkflowSchedule', {
    name: 'Scheduled inventory count', projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: new Date(current).toISOString() },
    missedFirePolicy: 'skip', enabled: true, runInput: { count: 17 },
  });
  await assert.rejects(f.act('saveWorkflowSchedule', {
    id: schedule.scheduleId, revision: schedule.revision,
    name: 'Invalid scheduled inventory count', projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: new Date(current).toISOString() },
    missedFirePolicy: 'skip', enabled: true, runInput: { count: 'seventeen' },
  }), /schema|input|count|type/i);

  current += 60_001;
  await f.runtime().tickWorkflowEvents();
  const firstRun = await until(async () => {
    const state = await f.state();
    return Object.values(state.workflowRuns ?? {}).find(value => value.provenance?.subscriptionId === schedule.scheduleId && value.flow?.status === 'completed');
  }, value => value, 'first scheduled input run did not complete');
  const firstDecision = Object.values((await f.state()).automationDecisionLedger).find(value => value.runId === firstRun.id);
  assert.deepEqual(firstDecision.runInput, { count: 17 });
  assert.deepEqual(inputs.map(value => value.input), [{ count: 17 }]);

  const currentSchedule = (await f.runtime().snapshot(undefined, f.client)).workflowSchedules.items.find(value => value.id === schedule.scheduleId);
  await f.act('saveWorkflowSchedule', {
    id: schedule.scheduleId, revision: currentSchedule.revision,
    name: 'Scheduled inventory count', projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: new Date(current - 60_001).toISOString() },
    missedFirePolicy: 'skip', enabled: true, runInput: { count: 31 },
  });
  current += 60_001;
  await f.runtime().tickWorkflowEvents();
  const secondRun = await until(async () => {
    const state = await f.state();
    return Object.values(state.workflowRuns ?? {}).find(value => value.id !== firstRun.id && value.provenance?.subscriptionId === schedule.scheduleId && value.flow?.status === 'completed');
  }, value => value, 'revised schedule input run did not complete');
  const after = await f.state();
  const original = after.automationDecisionLedger[firstDecision.decisionKey];
  assert.deepEqual(original.runInput, { count: 17 });
  assert.equal(original.runId, firstRun.id);
  assert.deepEqual(after.automationDecisionLedger && Object.values(after.automationDecisionLedger).find(value => value.runId === secondRun.id).runInput, { count: 31 });
  assert.deepEqual(inputs.map(value => value.input), [{ count: 17 }, { count: 31 }]);
  assert.equal(inputs.every(value => value.session === null), true);
  assert.equal((await f.runtime().snapshot(undefined, f.client)).sessions.length, 0);
});
