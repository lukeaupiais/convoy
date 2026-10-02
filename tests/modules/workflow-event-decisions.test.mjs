import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflows, normalizeWorkflow, activityDigest } from '../../apps/daemon/src/modules/workflows/index.mjs';

const event = {
  id: 'inventory.completed', revision: 1, label: 'Inventory completed',
  source: { owner: 'inventory' }, tenantScope: 'project',
  payload: [{ path: 'requestId', type: 'string', required: true }],
  correlationPaths: ['requestId'], maxPayloadBytes: 2048, manual: true,
};
const scheduleEvent = {
  id: 'workflow.schedule_fired', revision: 1, label: 'Schedule fired', source: { owner: 'workflows' },
  tenantScope: 'project', payload: [{ path: 'scheduleId', type: 'string', required: true },
    { path: 'scheduledFor', type: 'string', required: true }, { path: 'coveredThrough', type: 'string' }],
  correlationPaths: ['scheduleId'], maxPayloadBytes: 2048,
};

function fixture({ now = () => '2026-01-01T00:00:00.000Z' } = {}) {
  const workflow = { id: 'inventory-review', version: 1, organizationId: 'org-a', name: 'Inventory review', nodes: [
    { id: 'review', kind: 'human', name: 'Review', prompt: 'Review this inventory result.' },
  ], edges: [] };
  const rule = { id: 'inventory-subscription', revision: 3, name: 'Review inventory', organizationId: 'org-a',
    projectId: 'project-a', when: { event: event.id, eventRevision: event.revision }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 1, overflowPolicy: 'hold' }, enabled: true,
    principal: { kind: 'user', userId: 'operator-a' } };
  const state = { projects: [{ id: 'project-a', organizationId: 'org-a' }], workflows: [workflow], automations: [rule] };
  let starts = 0;
  const workflows = createWorkflows({ state, save: async () => {}, defaultWorkflow: workflow,
    normalize: normalizeWorkflow, validateBindings: () => {}, effects: {}, requestStop: async () => {},
    automations: { snapshot: () => [], validate: () => {} }, eventDescriptors: [event, scheduleEvent],
    engine: { async start(run) { starts++; run.flow = { workflowId: workflow.id, workflowVersion: workflow.version,
      nodeId: 'review', instance: `instance-${starts}`, status: 'waiting_gate', history: [] }; } },
    now,
  });
  return { state, workflows, rule, get starts() { return starts; } };
}

test('subscription reservations enforce capacity and explicit retry reuses the reserved run ID', async () => {
  const f = fixture();
  const first = await f.workflows.acceptEvent({ descriptor: { id: event.id, revision: 1 },
    source: { id: 'inventory.source-a', eventId: 'one' }, organizationId: 'org-a', projectId: 'project-a',
    payload: { requestId: 'one' }, correlation: { key: 'requestId', value: 'one' } });
  const second = await f.workflows.acceptEvent({ descriptor: { id: event.id, revision: 1 },
    source: { id: 'inventory.source-a', eventId: 'two' }, organizationId: 'org-a', projectId: 'project-a',
    payload: { requestId: 'two' }, correlation: { key: 'requestId', value: 'two' } });
  const [firstKey, firstDecision] = Object.entries(f.state.automationDecisionLedger).find(([, value]) => value.eventId === first.event.id);
  const [secondKey, secondDecision] = Object.entries(f.state.automationDecisionLedger).find(([, value]) => value.eventId === second.event.id);
  assert.equal(firstDecision.status, 'reserved');
  assert.equal(secondDecision.status, 'held');
  const firstRun = await f.workflows.ensureRunForDecision(firstKey);
  assert.equal(firstRun.id, firstDecision.runId);
  assert.equal(f.starts, 1);
  assert.equal(secondDecision.status, 'held', 'a later start must remain held while capacity is occupied');

  f.state.workflowRuns[firstRun.id].flow.status = 'completed';
  const retry = await f.workflows.retryEventDecision(secondKey);
  assert.equal(retry.runId, secondDecision.runId);
  const secondRun = await f.workflows.ensureRunForDecision(secondKey);
  assert.equal(secondRun.id, secondDecision.runId);
  assert.equal(f.starts, 2);
  assert.equal(Object.keys(f.state.workflowRuns).length, 2);
  assert.equal(activityDigest(secondRun.principal), activityDigest(f.rule.principal));
});

test('scheduler applies one shared work limit across due schedules', async () => {
  const f = fixture();
  for (const id of ['inventory-a', 'inventory-b']) await f.workflows.saveSchedule({
    id, revision: 0, name: id, organizationId: 'org-a', projectId: 'project-a',
    workflowId: 'inventory-review', workflowVersion: 1,
    principal: { kind: 'user', userId: 'operator-a' },
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: 'coalesce_once', enabled: true,
  });
  const first = await f.workflows.processDueSchedules('2026-01-01T00:05:00.000Z', { limit: 1 });
  assert.equal(first.processed, 1);
  assert.equal(f.state.workflowEventJournal.length, 1);
  const second = await f.workflows.processDueSchedules('2026-01-01T00:05:00.000Z', { limit: 1 });
  assert.equal(second.processed, 1);
  assert.equal(f.state.workflowEventJournal.length, 2);
  assert.equal(new Set(f.state.workflowEventJournal.map(value => value.source.id)).size, 2);
});

test('calendar schedules use IANA local time and deterministic daylight-saving resolution', async () => {
  async function nextFireAt(current, schedule, id) {
    const f = fixture({ now: () => current });
    const saved = await f.workflows.saveSchedule({ id, revision: 0, name: id, organizationId: 'org-a', projectId: 'project-a',
      workflowId: 'inventory-review', workflowVersion: 1, principal: { kind: 'user', userId: 'operator-a' },
      schedule, missedFirePolicy: 'skip', enabled: true });
    return saved.nextFireAt;
  }

  assert.equal(await nextFireAt('2026-03-08T05:00:00.000Z',
    { kind: 'calendar', frequency: 'daily', localTime: '02:30', timeZone: 'America/New_York' }, 'spring-gap'),
  '2026-03-09T06:30:00.000Z', 'nonexistent local time is skipped');
  assert.equal(await nextFireAt('2026-11-01T04:00:00.000Z',
    { kind: 'calendar', frequency: 'daily', localTime: '01:30', timeZone: 'America/New_York' }, 'fall-overlap'),
  '2026-11-01T05:30:00.000Z', 'ambiguous local time chooses its earlier instant');
  assert.equal(await nextFireAt('2026-01-07T00:00:00.000Z',
    { kind: 'calendar', frequency: 'weekly', weekday: 1, localTime: '09:00', timeZone: 'UTC' }, 'weekly-monday'),
  '2026-01-12T09:00:00.000Z');
  assert.equal(await nextFireAt('2026-01-31T00:00:00.000Z',
    { kind: 'calendar', frequency: 'monthly', dayOfMonth: 1, localTime: '09:00', timeZone: 'UTC' }, 'monthly-first'),
  '2026-02-01T09:00:00.000Z');
});

test('activity dispatch persists the event eligibility cursor before an external producer can emit', async () => {
  const f = fixture();
  const run = { id: 'run-a', independentRun: true, projectId: 'project-a', organizationId: 'org-a',
    workflow: { id: 'inventory-review', version: 1 }, flow: { instance: 'instance-a', nodeId: 'snapshot' },
    eventEligibilityCursor: 0,
    attempt: { instance: 'instance-a', nodeId: 'snapshot', activityRef: { id: 'inventory.snapshot', revision: 1 },
      intent: { requestId: 'snapshot-a' }, effectKey: 'run-a:instance-a:snapshot', status: 'ready' } };
  f.state.workflowRuns = { [run.id]: run };
  await f.workflows.acceptEvent({ descriptor: { id: scheduleEvent.id, revision: 1 },
    source: { id: 'workflow-schedule.cursor', eventId: 'before-dispatch' }, organizationId: 'org-a', projectId: 'project-a',
    payload: { scheduleId: 'cursor', scheduledFor: '2026-01-01T00:00:00.000Z' } });
  assert.equal(f.workflows.eventJournal.cursor(), 1);
  await f.workflows.markActivityDispatchStarted(run, { instance: 'instance-a', nodeId: 'snapshot',
    ref: run.attempt.activityRef });
  assert.equal(run.eventEligibilityCursor, 1);
  assert.equal(run.attempt.eventEligibilityCursor, 1);
  assert.equal(run.attempt.status, 'running');
});
