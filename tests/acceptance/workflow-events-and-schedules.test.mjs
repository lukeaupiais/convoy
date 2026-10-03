import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { defaultWorkflowDefinition, activityDigest } from '../../apps/daemon/src/modules/workflows/index.mjs';
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
const inventorySignal = {
  id: 'inventory.stock_counted', revision: 1, label: 'Stock counted',
  source: { owner: 'inventory-adapter' }, tenantScope: 'resource',
  payload: [{ path: 'count', type: 'number', required: true }],
  correlationPaths: [], maxPayloadBytes: 4096, manual: false,
};
const publicationRevision2 = {
  ...callback, revision: 2, label: 'Publication callback v2',
  payload: [{ path: 'requestId', type: 'string', required: true }, { path: 'status', type: 'number', required: true },
    { path: 'releaseChannel', type: 'enum', values: ['stable', 'preview'] }],
};
const nestedCallback = {
  id: 'publication.nested_callback', revision: 1, label: 'Nested publication callback',
  source: { owner: 'publication-adapter' }, tenantScope: 'project',
  payload: [{ path: 'document.reference', type: 'string', required: true }, { path: 'document.status', type: 'enum', values: ['published', 'rejected'], required: true }],
  correlationPaths: ['document.reference'], maxPayloadBytes: 4096, manual: true,
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

test('resource-scoped inventory subscriptions preserve generic scope without Work import bindings', async t => {
  const f = await fixture(t, { workflowEvents: [inventorySignal] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-count-review', name: 'Inventory count review',
    nodes: [{ id: 'review', name: 'Review count', kind: 'human', prompt: 'Review the stock count.' }], edges: [],
  } });
  const advertised = (await f.snapshot()).automationCapabilities.events.find(value => value.id === inventorySignal.id);
  assert.equal(advertised.scope, 'resource');
  assert.equal(advertised.descriptorId, inventorySignal.id);
  const resourceRef = { kind: 'stock-item', id: 'SKU-4821' };
  const saved = await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    name: 'Review a stock count', projectId: f.project.id,
    when: { event: inventorySignal.id, eventRevision: 1, resourceRef },
    if: [{ path: 'count', operator: 'greaterThan', value: 0 }],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 2 }, enabled: true,
  } });
  assert.deepEqual(saved.when.resourceRef, resourceRef);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.automations.find(value => value.id === saved.id).when.resourceRef.id, 'SKU-4821');
  assert.equal(snapshot.automationCapabilities.events.find(value => value.id === inventorySignal.id).scope, 'resource');
  assert.equal(snapshot.workflowRuns.length, 0);
  assert.equal(snapshot.sessions.length, 0);
});

test('manual event correlation reads declared nested paths', async t => {
  const f = await fixture(t, { workflowEvents: [nestedCallback] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'nested-callback-wait', name: 'Wait for nested callback',
    runInputSchema: { type: 'object', properties: { document: { type: 'object', properties: { reference: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['reference'], additionalProperties: false } }, required: ['document'], additionalProperties: false },
    nodes: [{ id: 'callback', name: 'Callback', kind: 'wait', waitFor: {
      event: nestedCallback.id, scope: 'project',
      correlation: { key: 'document.reference', from: 'runInput.document.reference' },
      if: [{ path: 'document.status', operator: 'equals', value: 'published' }],
    } }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { document: { reference: 'pub-nested-42' } } });
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId })).status, 'waiting_event');
  await f.act('submitWorkflowEvent', { descriptorId: nestedCallback.id, idempotencyKey: 'nested-42',
    payload: { document: { reference: 'pub-nested-42', status: 'published' } } });
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId })).status, 'completed');
  const stored = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.deepEqual(stored.workflowEventJournal[0].correlation, { key: 'document.reference', value: 'pub-nested-42' });
});

test('legacy Work ticket_moved facts trigger a no-session workflow run through the event owner', async t => {
  const f = await fixture(t);
  const ticket = await f.act('createTicket', { requestId: 'moved-event-ticket', projectId: f.project.id, title: 'Inventory arrival' });
  const board = await f.act('saveBoard', { name: 'Inventory queue', projectIds: [f.project.id], columns: [
    { id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' },
  ] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-arrival-review', name: 'Inventory arrival review',
    nodes: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Review the inventory arrival.' }], edges: [],
  } });
  await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    name: 'Review moved inventory', projectId: f.project.id, enabled: true,
    when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 1, overflowPolicy: 'reject' },
  } });
  await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } });
  const snapshot = await f.snapshot();
  assert.equal(snapshot.sessions.length, 0);
  const summary = snapshot.workflowRuns.find(value => value.workflowId === workflow.id);
  assert.equal(summary.status, 'waiting_gate');
  const decision = snapshot.workflowEventDecisions.items.find(value => value.runId === summary.id);
  assert.equal(decision.status, 'started');
  assert.equal(decision.sourceEventId?.startsWith('ticket_moved:'), true);
});

test('event decision restart reuses its reserved run ID and never replays an applied activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-event-run-recovery-'));
  const markerPath = join(directory, 'reserved-run.json');
  const receiptPath = join(directory, 'adapter-receipt.json');
  const client = 'event-decision-recovery';
  const committed = { ...inventory, ref: { id: 'inventory.durable-commit', revision: 1 },
    inputSchema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { receiptId: { type: 'string', minLength: 1, maxLength: 160 }, recordId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['receiptId', 'recordId'], additionalProperties: false },
    effect: 'durable-effect', approval: { required: false }, cancellation: 'reconcile-after-dispatch',
    confirmation: 'adapter-confirmed', reconciliation: 'adapter' };
  const registration = { descriptor: committed, implementation: {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, recordId: input.recordId }; },
    async dispatch(_context, input, intent) {
      const previous = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => 'null'));
      if (previous) throw new Error('The durable effect must not be replayed.');
      const receipt = { receiptId: `receipt:${intent.requestKey}`, recordId: input.recordId };
      await writeFile(receiptPath, JSON.stringify({ dispatches: 1, receipt, requestKey: intent.requestKey }));
      await writeFile(markerPath, JSON.stringify({ phase: 'effect-applied', requestKey: intent.requestKey }));
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    },
    async reconcile(_context, input, intent, request) {
      const saved = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => 'null'));
      if (request.requestedResolution === 'applied' && saved?.requestKey === intent.requestKey && saved.receipt.recordId === input.recordId)
        return { state: 'applied', output: structuredClone(saved.receipt) };
      return { state: 'unknown' };
    },
    async confirm() { return { state: 'waiting', output: { receiptId: 'pending', recordId: 'pending' } }; },
  } };
  const options = { directory, models: [{ id: 'fixture' }], workflowEvents: [callback], workflowActivities: [registration],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Durable daemon activity must not call the provider.'); },
    runners: { execute: async () => { assert.fail('Durable daemon activity must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = null;
  const children = [];
  const close = async () => { if (runtime) { const current = runtime; runtime = null; await current.close(); } };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime(options);
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const project = await act('saveProject', { name: 'Event recovery' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
  const workflow = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'durable-event-commit', name: 'Durable event commit',
    runInputSchema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'], additionalProperties: false },
    nodes: [{ id: 'commit', name: 'Commit inventory', kind: 'action', activity: committed.ref,
      bindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } } }], edges: [],
  } });
  await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
    name: 'Commit inventory callback', projectId: project.id, when: { event: callback.id, eventRevision: 1 }, if: [],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version,
      inputBindings: { recordId: { from: { kind: 'event_payload', path: ['requestId'] } } } },
    concurrency: { policy: 'independent', maxActiveRuns: 2 }, enabled: true,
  } });
  await close();

  const persistenceUrl = new URL('../../apps/daemon/src/adapters/persistence/index.mjs', import.meta.url).href;
  const runtimeUrl = new URL('../../apps/daemon/src/control-plane/runtime.mjs', import.meta.url).href;
  const schemaUrl = new URL('../../apps/daemon/src/control-plane/state-schema.mjs', import.meta.url).href;
  const workflowsUrl = new URL('../../apps/daemon/src/modules/workflows/index.mjs', import.meta.url).href;
  const childSource = `
    import { writeFile, readFile } from 'node:fs/promises';
    import { createPersistence } from ${JSON.stringify(persistenceUrl)};
    import { createRuntime } from ${JSON.stringify(runtimeUrl)};
    import { initialControlPlaneState } from ${JSON.stringify(schemaUrl)};
    import { defaultWorkflowDefinition } from ${JSON.stringify(workflowsUrl)};
    const [directory, client, projectId, markerPath, receiptPath, phase] = process.argv.slice(1);
    const event = ${JSON.stringify(callback)};
    const descriptor = ${JSON.stringify(committed)};
    const implementation = {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, recordId: input.recordId }; },
      async dispatch(_context, input, intent) {
        const previous = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => 'null'));
        if (previous) throw new Error('The durable effect must not be replayed.');
        const receipt = { receiptId: 'receipt:' + intent.requestKey, recordId: input.recordId };
        await writeFile(receiptPath, JSON.stringify({ dispatches: 1, receipt, requestKey: intent.requestKey }));
        await writeFile(markerPath, JSON.stringify({ phase: 'effect-applied', requestKey: intent.requestKey }));
        await new Promise(() => {});
      },
      async reconcile(_context, input, intent, request) {
        const saved = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => 'null'));
        if (request.requestedResolution === 'applied' && saved?.requestKey === intent.requestKey && saved.receipt.recordId === input.recordId)
          return { state: 'applied', output: saved.receipt };
        return { state: 'unknown' };
      },
      async confirm() { return { state: 'waiting', output: { receiptId: 'pending', recordId: 'pending' } }; },
    };
    const persistence = await createPersistence({ directory, initialState: initialControlPlaneState(defaultWorkflowDefinition) });
    if (phase === 'reserved') {
      const save = persistence.store.save.bind(persistence.store);
      let blocked = false;
      persistence.store.save = async () => {
        const result = await save();
        const decision = Object.values(persistence.store.data.automationDecisionLedger ?? {}).find(value => value.workflowId === 'durable-event-commit');
        const run = decision && persistence.store.data.workflowRuns?.[decision.runId];
        if (!blocked && decision?.status === 'reserved' && run) {
          blocked = true;
          await writeFile(markerPath, JSON.stringify({ phase: 'reserved-run', runId: run.id, status: decision.status }));
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        }
        return result;
      };
    }
    const runtime = await createRuntime({ persistence, models: [{ id: 'fixture' }], workflowEvents: [event],
      workflowActivities: [{ descriptor, implementation }],
      auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
      generate: async function* () { throw new Error('No provider call is expected.'); },
      runners: { execute: async () => { throw new Error('No runner is expected.'); }, close: async () => {} },
    });
    await runtime.command({ action: 'selectActiveContext', client, context: { organizationId: 'personal', projectId } });
    await runtime.command({ action: 'submitWorkflowEvent', client, descriptorId: event.id, descriptorRevision: 1,
      idempotencyKey: 'event-recovery-91', payload: { requestId: 'inventory-record-91', status: 'published' } });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `;
  async function crashChild(phase, expectedPhase) {
    await rm(markerPath, { force: true });
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource,
      directory, client, project.id, markerPath, receiptPath, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let marker;
    try {
      marker = await until(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited early (${child.exitCode ?? child.signalCode}): ${stdout}${stderr}`);
        try { return JSON.parse(await readFile(markerPath, 'utf8')); } catch { return null; }
      }, `child did not reach ${expectedPhase}: ${stdout}${stderr}`);
    } catch (error) {
      const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8').catch(() => 'null'));
      throw new Error(`${error.message}; child=${stdout}${stderr}; persisted=${JSON.stringify({ journal:saved?.workflowEventJournal, automations:saved?.automations, decisions: saved?.automationDecisionLedger, runs: saved?.workflowRuns && Object.values(saved.workflowRuns).map(run => ({id:run.id,status:run.status,flow:run.flow,attempt:run.attempt})) })}`);
    }
    assert.equal(marker.phase, expectedPhase, stderr);
    if (phase === 'reserved') assert.equal(marker.status, 'reserved');
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    return marker;
  }
  const reserved = await crashChild('reserved', 'reserved-run');
  const applied = await crashChild('effect', 'effect-applied');
  assert.equal(applied.requestKey.startsWith(`${reserved.runId}:`), true);

  runtime = await createRuntime(options);
  const resumed = await until(async () => {
    const value = await act('getWorkflowRun', { workflowRunId: reserved.runId });
    return value.attempt?.status === 'uncertain' ? value : null;
  }, 'restarted event run did not retain the uncertain exact activity');
  assert.equal(resumed.id, reserved.runId);
  assert.equal(resumed.status === 'completed', false);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(Object.keys(state.workflowRuns).length, 1);
  assert.equal(Object.values(state.automationDecisionLedger).filter(value => value.workflowId === workflow.id).length, 1);
  assert.equal(Object.values(state.automationDecisionLedger).find(value => value.workflowId === workflow.id).runId, reserved.runId);
  const decision = Object.values(state.automationDecisionLedger).find(value => value.workflowId === workflow.id);
  const pinnedRun = state.workflowRuns[reserved.runId];
  assert.deepEqual(decision.runInput, { recordId: 'inventory-record-91' });
  assert.equal(decision.runInputDigest, activityDigest({ recordId: 'inventory-record-91' }));
  assert.deepEqual(pinnedRun.runInput, decision.runInput);
  assert.equal(pinnedRun.runInputDigest, decision.runInputDigest);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).dispatches, 1);
  assert.equal((await runtime.snapshot(undefined, client)).sessions.length, 0);
  await act('claimWorkflowRun', { workflowRunId: reserved.runId });
  await act('reconcileWorkflowRun', { workflowRunId: reserved.runId, instance: resumed.instance,
    effectKey: `${reserved.runId}:${resumed.instance}:commit`, resolution: 'applied' });
  const completed = await act('getWorkflowRun', { workflowRunId: reserved.runId });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt.status, 'completed');
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).dispatches, 1);
});

test('workflow event publication validates typed predicates against the selected revision', async t => {
  const f = await fixture(t, { workflowEvents: [callback, publicationRevision2] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'revision-review', name: 'Review callback revisions',
    nodes: [{ id: 'review', name: 'Review callback', kind: 'human', prompt: 'Review the callback.' }], edges: [],
  } });
  const waitWorkflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'revision-wait', name: 'Wait on v1 callback',
    runInputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
    nodes: [{ id: 'callback', name: 'Callback', kind: 'wait', waitFor: {
      event: callback.id, eventRevision: 1, scope: 'project',
      correlation: { key: 'requestId', from: 'runInput.requestId' },
    } }], edges: [],
  } });
  const v1 = await f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Review v1 callbacks', projectId: f.project.id, when: { event: callback.id, eventRevision: 1 },
    if: [{ path: 'status', operator: 'equals', value: 'published' }],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 5 }, enabled: true,
  }, revision: 0 });
  const v2 = await f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Review v2 callbacks', projectId: f.project.id, when: { event: callback.id, eventRevision: 2 },
    if: [{ path: 'status', operator: 'greaterThan', value: 10 }],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version },
    concurrency: { policy: 'independent', maxActiveRuns: 5 }, enabled: true,
  }, revision: 0 });
  await assert.rejects(f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Invalid v1 numeric predicate', projectId: f.project.id, when: { event: callback.id, eventRevision: 1 },
    if: [{ path: 'status', operator: 'greaterThan', value: 10 }],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version }, enabled: false,
  }, revision: 0 }), /condition/i);
  await assert.rejects(f.act('saveAutomation', { organizationId: 'personal', rule: {
    name: 'Invalid v1 field predicate', projectId: f.project.id, when: { event: callback.id, eventRevision: 1 },
    if: [{ path: 'releaseChannel', operator: 'equals', value: 'stable' }],
    then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: workflow.version }, enabled: false,
  }, revision: 0 }), /condition/i);
  assert.equal(v1.when.eventRevision, 1);
  assert.equal(v2.when.eventRevision, 2);
  const waiting = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: waitWorkflow.id, workflowVersion: waitWorkflow.version,
    runInput: { requestId: 'revision-request' } });
  const pinnedState = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(pinnedState.workflows.find(value => value.id === waitWorkflow.id).nodes[0].waitFor.eventRevision, 1);
  const pinnedWait = Object.values(pinnedState.workflowWaits).find(value => value.runId === waiting.workflowRunId && value.nodeId === 'callback');
  assert.equal(pinnedWait.descriptor.revision, 1);
  await f.act('submitWorkflowEvent', { descriptorId: callback.id, descriptorRevision: 2, idempotencyKey: 'revision-2',
    payload: { requestId: 'revision-request', status: 12 } });
  await f.runtime().tickWorkflowEvents();
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: waiting.workflowRunId })).status, 'waiting_event');
  await f.act('submitWorkflowEvent', { descriptorId: callback.id, descriptorRevision: 1, idempotencyKey: 'revision-1',
    payload: { requestId: 'revision-request', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: waiting.workflowRunId })).status, 'completed');
  const state = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(state.workflows.find(value => value.id === waitWorkflow.id).nodes[0].waitFor.eventRevision, 1);
  const finalPinnedWait = Object.values(state.workflowWaits).find(value => value.runId === waiting.workflowRunId && value.nodeId === 'callback');
  assert.equal(finalPinnedWait.descriptor.revision, 1);
  assert.equal(Object.values(state.automationDecisionLedger).filter(value => value.sourceEvent?.descriptor?.revision === 1).length, 1);
});

test('durable interval schedule coalesces missed slots and starts one no-agent inventory run', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const calls = [];
  const registration = { descriptor: inventory, implementation: {
    async prepare(_input, _identity, context) { assert.equal(context.session, null); return { count: 1 }; },
    async dispatch(context) { calls.push(context); return { state: 'completed', output: { count: 17 } }; },
  } };
  const f = await fixture(t, { workflowActivities: [registration], clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-reconciliation', name: 'Inventory reconciliation',
    nodes: [{ id: 'snapshot', name: 'Snapshot', kind: 'action', activity: inventory.ref, bindings: {} }], edges: [],
  } });
  const otherProject = await f.act('saveProject', { name: 'Other inventory project' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: otherProject.id } });
  const otherWorkflow = await f.act('saveWorkflow', { projectId: otherProject.id, workflow: {
    id: 'other-inventory', name: 'Other inventory',
    nodes: [{ id: 'snapshot', name: 'Snapshot', kind: 'action', activity: inventory.ref, bindings: {} }], edges: [],
  } });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: f.project.id } });
  const schedule = await f.act('saveWorkflowSchedule', {
    name: 'Daily inventory snapshot', projectId: f.project.id, workflowId: workflow.id,
    workflowVersion: workflow.version, schedule: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: 'coalesce_once', enabled: true,
  });
  await assert.rejects(f.act('saveWorkflowSchedule', { id: schedule.scheduleId, revision: schedule.revision,
    name: 'Moved schedule', projectId: otherProject.id, workflowId: otherWorkflow.id, workflowVersion: otherWorkflow.version,
    schedule: { kind: 'interval', everySeconds: 120, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: 'skip', enabled: true }), /cannot move/i);
  current += 3 * 60_000 + 1000;
  const tick = await f.runtime().tickWorkflowEvents();
  const run = await until(async () => {
    const value = (await f.snapshot()).workflowRuns[0];
    if (!value) return null;
    const currentRun = await f.act('getWorkflowRun', { workflowRunId: value.id });
    return currentRun.status === 'completed' ? currentRun : null;
  }, `scheduled run did not complete; tick=${JSON.stringify(tick)}; run=${JSON.stringify((({ id, independentRun, sessionId, flow, attempt }) => ({ id, independentRun, sessionId, flow, attempt }))(Object.values(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).workflowRuns ?? {})[0] ?? null))}`);
  const scheduledDecision = Object.values(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).automationDecisionLedger)
    .find(value => value.runId === run.id);
  assert.equal(scheduledDecision.subscriptionId, schedule.scheduleId);
  const completedRun = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).workflowRuns[run.id];
  assert.equal(completedRun.activityOutputs.snapshot.value.count, 17);
  assert.equal(calls.length, 1);
  assert.equal((await f.snapshot()).sessions.length, 0);
  await f.restart();
  await f.runtime().tickWorkflowEvents();
  const persisted = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.keys(persisted.workflowRuns).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(Object.values(persisted.workflowScheduleFirings).filter(value => value.status === 'accepted').length, 1);
});

test('catch-up schedules preserve remaining due slots for later bounded passes', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const calls = [];
  const registration = { descriptor: inventory, implementation: {
    async prepare() { return {}; },
    async dispatch(context) { calls.push(context); return { state: 'completed', output: { count: calls.length } }; },
  } };
  const f = await fixture(t, { workflowActivities: [registration], clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-catch-up', name: 'Inventory catch up',
    nodes: [{ id: 'snapshot', name: 'Snapshot', kind: 'action', activity: inventory.ref, bindings: {} }], edges: [],
  } });
  await f.act('saveWorkflowSchedule', { name: 'Bounded inventory catch up', projectId: f.project.id,
    workflowId: workflow.id, workflowVersion: workflow.version,
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: { catchUp: { maxFirings: 2 } }, enabled: true });
  current += 6 * 60_000 + 1000;

  await f.runtime().tickWorkflowEvents();
  await until(() => calls.length === 2, 'first catch-up pass did not dispatch two runs');
  assert.equal(calls.length, 2);
  let stored = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.values(stored.workflowScheduleFirings).filter(value => value.status === 'accepted').length, 2);
  assert.equal(stored.workflowSchedules[0].nextFireAt, '2026-01-01T00:03:00.000Z');

  await f.runtime().tickWorkflowEvents();
  await until(() => calls.length === 4, 'second catch-up pass did not dispatch two runs');
  await f.runtime().tickWorkflowEvents();
  await until(() => calls.length === 6, 'third catch-up pass did not dispatch two runs');
  stored = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.values(stored.workflowScheduleFirings).filter(value => value.status === 'accepted').length, 6);
  assert.equal(new Set(Object.values(stored.workflowScheduleFirings).filter(value => value.status === 'accepted').map(value => value.scheduledFor)).size, 6);
});

test('skip policy records an old interval backlog without a 500-slot replay cap', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-backlog', name: 'Inventory backlog',
    nodes: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Review the inventory run.' }], edges: [],
  } });
  const schedule = await f.act('saveWorkflowSchedule', { name: 'Skip inventory backlog', projectId: f.project.id,
    workflowId: workflow.id, workflowVersion: workflow.version,
    schedule: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' },
    missedFirePolicy: 'skip', enabled: true });
  current += 1000 * 60_000 + 1000;
  await f.runtime().tickWorkflowEvents();
  const stored = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  const firings = Object.values(stored.workflowScheduleFirings).filter(value => value.scheduleId === schedule.scheduleId);
  assert.equal(firings.length, 2);
  const skipped = firings.find(value => value.status === 'skipped');
  const accepted = firings.find(value => value.status === 'accepted');
  assert.equal(skipped.skippedCount, 999);
  assert.equal(skipped.scheduledFor, '2026-01-01T00:01:00.000Z');
  assert.equal(skipped.coveredThrough, '2026-01-01T16:39:00.000Z');
  assert.equal(accepted.scheduledFor, '2026-01-01T16:40:00.000Z');
  assert.equal(Object.keys(stored.workflowRuns).length, 1);
});

test('standalone adapter failures leave a truthful failed run and activity attempt', async t => {
  const failure = { ...inventory, ref: { id: 'inventory.failure', revision: 1 } };
  const f = await fixture(t, { workflowActivities: [{ descriptor: failure, implementation: {
    async prepare() { return {}; },
    async dispatch() { throw new Error('Inventory adapter rejected the request.'); },
  } }] });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'inventory-failure', name: 'Inventory failure',
    nodes: [{ id: 'snapshot', name: 'Snapshot', kind: 'action', activity: failure.ref, bindings: {} }], edges: [],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version });
  const run = await until(async () => {
    const value = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
    return value.status === 'failed' ? value : null;
  });
  assert.equal(run.attempt.status, 'failed');
  assert.match(run.attempt.message, /rejected the request/i);
  assert.equal((await f.snapshot()).sessions.length, 0);
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
  const otherProject = await f.act('saveProject', { name: 'Other callback project' });
  await f.act('createMembership', { organizationId: 'personal', principal, scope: { kind: 'project', projectId: otherProject.id }, roles: ['contributor'] });
  await assert.rejects(f.act('saveWorkflowWebhookBinding', { id: binding.bindingId, revision: binding.revision,
    name: 'Moved callback source', descriptorId: callback.id, descriptorRevision: callback.revision,
    projectId: otherProject.id, servicePrincipalId: principal.servicePrincipalId, eventIdPath: 'eventId',
    fieldMap: [{ targetPath: 'requestId', sourcePath: 'requestId' }, { targetPath: 'status', sourcePath: 'status' }], enabled: false }), /cannot move/i);
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

test('an event received after a wait deadline cannot beat its persisted timeout', async t => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const f = await fixture(t, { clock: () => current });
  const workflow = await f.act('saveWorkflow', { projectId: f.project.id, workflow: {
    id: 'publication-timeout-race', name: 'Publication timeout race',
    runInputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
    nodes: [
      { id: 'wait', kind: 'wait', name: 'Wait for callback', waitFor: { event: callback.id, eventRevision: 1, scope: 'project',
        correlation: { key: 'requestId', from: 'runInput.requestId' }, timeoutSeconds: 60, timeoutOutcome: 'expired' } },
      { id: 'delivered', kind: 'human', name: 'Callback delivered', prompt: 'Review the callback.' },
      { id: 'expired', kind: 'human', name: 'Callback expired', prompt: 'Review the missing callback.' },
    ], edges: [{ from: 'wait', to: 'delivered', outcome: 'success' }, { from: 'wait', to: 'expired', outcome: 'expired' }],
  } });
  const started = await f.act('startWorkflowRun', { projectId: f.project.id, workflowId: workflow.id, workflowVersion: workflow.version,
    runInput: { requestId: 'timeout-request' } });
  current += 61_000;
  await f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'late-timeout-callback',
    payload: { requestId: 'timeout-request', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  const run = await f.act('getWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal(run.nodeId, 'expired');
  assert.equal(run.status, 'waiting_gate');
  const persisted = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(Object.values(persisted.workflowWaits).find(value => value.runId === started.workflowRunId).status, 'timed_out');
  assert.equal(Object.values(persisted.workflowDeadlines).find(value => value.runId === started.workflowRunId).status, 'fired');
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
  const sameOrganizationProject = await f.act('saveProject', { name: 'Another publication project' });
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: sameOrganizationProject.id } });
  await f.act('submitWorkflowEvent', { descriptorId: callback.id, idempotencyKey: 'other-project-correlation',
    payload: { requestId: 'expected-callback', status: 'published' } });
  await f.runtime().tickWorkflowEvents();
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: first.workflowRunId })).status, 'waiting_event',
    'a resource/project event from another project in the same organization cannot wake this run');
  await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: f.project.id } });
  await f.restart();
  current += 61_000;
  await f.runtime().tickWorkflowEvents();
  const timedOut = await f.act('getWorkflowRun', { workflowRunId: second.workflowRunId });
  assert.equal(timedOut.status, 'completed');
  assert.equal(timedOut.history.at(-1).outcome, 'timeout');
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: first.workflowRunId })).status, 'waiting_event');
  assert.equal((await f.snapshot()).sessions.length, 0);
});
