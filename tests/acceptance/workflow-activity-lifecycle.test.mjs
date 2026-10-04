import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/index.mjs';

const string = (maxLength = 200) => ({ type: 'string', maxLength });
const integer = (minimum = 0, maximum = 1_000_000) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const idempotencyKey = (runId, instance) => `${runId}:${instance}`;

function descriptor(id, inputSchema, outputSchema, effect) {
  const durable = effect === 'durable-effect';
  return {
    ref: { id, revision: 1 }, inputSchema, outputSchema,
    resources: { location: 'integration', adapterId: 'lifecycle-fake' }, effect,
    approval: { required: false }, cancellation: durable ? 'reconcile-after-dispatch' : 'immediate',
    confirmation: durable ? 'adapter-confirmed' : 'result', reconciliation: durable ? 'adapter' : 'none',
    presentation: { label: id },
  };
}

const pureInput = object({ code: string(40) }, ['code']);
const pureOutput = object({ normalized: string(40) }, ['normalized']);
const durableInput = object({ recordId: string(80), quantity: integer(1, 100_000) }, ['recordId', 'quantity']);
const durableOutput = object({ receiptId: string(160), recordId: string(80), accepted: { type: 'boolean' } }, ['receiptId', 'recordId', 'accepted']);

function activityNode(id, ref, input) {
  return { id, name: id, kind: 'action', activity: { id: ref, revision: 1 },
    bindings: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { literal: value }])) };
}

async function waitFor(read, predicate, message, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

async function within(promise, message, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function processExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(t, { workflowActivities = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-activity-lifecycle-'));
  const client = 'workflow-activity-lifecycle-acceptance';
  const options = {
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('No workflow activity in this fixture should call a provider.'); },
    runners: { execute: async () => { assert.fail('No workflow activity in this fixture should call a runner.'); }, close: async () => {} },
    workflowActivities,
  };
  let runtime;
  const beforeClose = [];
  t.after(async () => {
    for (const cleanup of beforeClose) await cleanup();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime = await createRuntime(options);
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const org = await act('createOrganization', { slug: `lifecycle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, displayName: 'Lifecycle acceptance', kind: 'team' });
  const project = await act('saveProject', { organizationId: org.id, name: 'Workflow activity lifecycle' });
  await act('selectActiveContext', { context: { organizationId: org.id, projectId: project.id } });
  return {
    directory, client, org, project, act,
    beforeClose(fn) { beforeClose.push(fn); },
    async publish(id, nodes, edges = []) {
      return act('saveWorkflow', { projectId: project.id, workflow: { id, name: id, nodes, edges } });
    },
    async run(id) {
      const published = (await runtime.snapshot(undefined, client)).workflows.find(value => value.id === id);
      assert.ok(published, `published workflow ${id} exists`);
      return act('startWorkflowRun', { projectId: project.id, workflowId: id, workflowVersion: published.version });
    },
    async read(id) { return act('getWorkflowRun', { workflowRunId: id }); },
    async state() { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); },
    async restart() {
      await runtime.close();
      runtime = await createRuntime(options);
    },
    async close() {
      await runtime?.close();
      runtime = null;
    },
    async openWith(nextActivities = workflowActivities) {
      await runtime?.close();
      runtime = await createRuntime({ ...options, workflowActivities: nextActivities });
    },
  };
}

test('cancelling an in-flight pure activity aborts it and never dispatches downstream work', async t => {
  const entered = deferred();
  let dispatches = 0;
  let downstreamDispatches = 0;
  let observedAbort = false;
  const first = descriptor('data.normalize-code', pureInput, pureOutput, 'pure');
  const second = descriptor('inventory.summarize', object({ count: integer(0, 100_000) }, ['count']),
    object({ total: integer(0, 100_000) }, ['total']), 'pure');
  const f = await fixture(t, { workflowActivities: [
    { descriptor: first, implementation: {
      async prepare(input) { return { source: input.code }; },
      async dispatch(_context, input, _intent, signal) {
        dispatches += 1;
        entered.resolve();
        return new Promise(resolve => signal.addEventListener('abort', () => {
          observedAbort = true;
          resolve({ state: 'failed', message: 'Pure computation stopped.' });
        }, { once: true }));
      },
    } },
    { descriptor: second, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) { downstreamDispatches += 1; return { state: 'completed', output: { total: input.count } }; },
    } },
  ] });
  await f.publish('pure-cancellation-chain', [
    activityNode('normalize', first.ref.id, { code: 'abc' }),
    activityNode('summarize', second.ref.id, { count: 3 }),
  ], [{ from: 'normalize', to: 'summarize', outcome: 'success' }]);
  const { workflowRunId } = await f.run('pure-cancellation-chain');
  await within(entered.promise, 'pure activity did not reach its controlled dispatch barrier');
  const active = await f.read(workflowRunId);
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  const cancelled = await f.read(workflowRunId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(observedAbort, true, 'the active implementation receives the workflow abort signal');
  assert.equal(cancelled.attempt.status, 'cancelled');
  assert.equal(cancelled.instance, active.instance);
  assert.equal(dispatches, 1);
  assert.equal(downstreamDispatches, 0);
  assert.equal(Object.keys((await f.state()).sessions ?? {}).length, 0);
});

test('a running pure attempt safely recomputes after process loss and a completed receipt survives another restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-pure-crash-'));
  const crashMarker = join(directory, 'dispatch-entered.json');
  const childFailure = join(directory, 'child-error.txt');
  const countPath = join(directory, 'dispatch-count.json');
  const client = 'workflow-pure-crash-acceptance';
  const runtimePath = pathToFileURL(new URL('../../apps/daemon/src/bootstrap/runtime-factory.mjs', import.meta.url).pathname).href;
  let runtime;
  let child;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([processExit(child), new Promise(resolve => setTimeout(resolve, 1000))]);
      child.unref();
      child.stderr?.destroy();
    }
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Pure activity must not call a provider.'); }, runners: { execute: async () => { assert.fail('Pure activity must not call a runner.'); }, close: async () => {} },
  };
  const pure = descriptor('data.normalize-code', pureInput, pureOutput, 'pure');
  const restartImplementation = {
    async prepare(input) { return { source: input.code }; },
    async dispatch(context, input, intent) {
      const current = JSON.parse(await readFile(countPath, 'utf8').catch(() => '0'));
      await writeFile(countPath, JSON.stringify(current + 1));
      return { state: 'completed', output: { normalized: `${intent.source}:${input.code}` } };
    },
  };
  runtime = await createRuntime({ ...options, workflowActivities: [{ descriptor: pure, implementation: restartImplementation }] });
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const org = await act('createOrganization', { slug: `pure-crash-${Date.now()}`, displayName: 'Pure crash test', kind: 'team' });
  const project = await act('saveProject', { organizationId: org.id, name: 'Pure crash' });
  await act('selectActiveContext', { context: { organizationId: org.id, projectId: project.id } });
  await act('saveWorkflow', { projectId: project.id, workflow: { id: 'pure-crash', name: 'Pure crash',
    nodes: [activityNode('normalize', pure.ref.id, { code: 'stable' })], edges: [] } });
  const version = (await runtime.snapshot(undefined, client)).workflows.find(value => value.id === 'pure-crash').version;
  await runtime.close();
  runtime = null;

  const moduleSpecifier = JSON.stringify(runtimePath);
  const args = [directory, client, project.id, version, crashMarker, countPath, childFailure];
  const childSource = `
    import { createRuntime } from ${moduleSpecifier};
    import { writeFile } from 'node:fs/promises';
    const [directory, client, projectId, workflowVersion, marker, countPath, failurePath] = process.argv.slice(1);
    const descriptor = ${JSON.stringify(pure)};
    const implementation = {
      async prepare(input) { return { source: input.code }; },
      async dispatch(context, input, intent) {
        const current = JSON.parse(await import('node:fs/promises').then(({readFile}) => readFile(countPath, 'utf8')).catch(() => '0'));
        await writeFile(countPath, JSON.stringify(current + 1));
        await writeFile(marker, JSON.stringify({ runId: context.run.id, instance: context.instance, input, intent }));
        await new Promise(() => {});
      },
    };
    try {
      const runtime = await createRuntime({ directory, models: [{ id: 'fixture' }],
        auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
        generate: async function* () { throw new Error('Pure activity must not call a provider.'); },
        runners: { execute: async () => { throw new Error('Pure activity must not call a runner.'); }, close: async () => {} },
        workflowActivities: [{ descriptor, implementation }] });
      await runtime.command({ action: 'startWorkflowRun', client, projectId, workflowId: 'pure-crash', workflowVersion: Number(workflowVersion) });
      await new Promise(() => {});
    } catch (error) {
      await writeFile(failurePath, String(error?.stack ?? error));
      process.exitCode = 1;
    }
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', childSource, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { childError += chunk; });
  let marker;
  try {
    const signal = await waitFor(async () => {
      try { return { marker: JSON.parse(await readFile(crashMarker, 'utf8')) }; } catch {}
      try { return { error: await readFile(childFailure, 'utf8') }; } catch { return null; }
    }, value => Boolean(value?.marker?.runId || value?.error), 'child process did not enter pure dispatch');
    if (signal.error) throw new Error(`Child runtime failed before dispatch: ${signal.error}`);
    marker = signal.marker;
  } catch (error) {
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8').catch(() => '{}'));
    const childFailureText = await readFile(childFailure, 'utf8').catch(() => '');
    throw new Error(`${error.message}; childExit=${child.exitCode}/${child.signalCode}; stderr=${childError}; childFailure=${childFailureText}; runStates=${JSON.stringify(Object.values(stored.workflowRuns ?? {}).map(run => ({ status: run.flow?.status, attempt: run.attempt?.status, message: run.attempt?.message })))}`);
  }
  const beforeKill = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const running = beforeKill.workflowRuns[marker.runId];
  assert.equal(running.attempt.status, 'running');
  assert.equal(running.attempt.instance, marker.instance);
  assert.equal(running.attempt.effect, 'pure');
  child.kill('SIGKILL');
  await within(processExit(child), 'crashed child process did not exit');
  child = null;

  runtime = await within(createRuntime({ ...options, workflowActivities: [{ descriptor: pure, implementation: restartImplementation }] }), 'runtime did not recover after child crash');
  const actAgain = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const interrupted = await actAgain('getWorkflowRun', { workflowRunId: marker.runId });
  assert.equal(interrupted.status, 'interrupted');
  assert.notEqual(interrupted.attempt.status, 'uncertain', 'a pure attempt does not require effect reconciliation');
  assert.equal(interrupted.instance, marker.instance);
  const recoveredState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(recoveredState.workflowRuns[marker.runId].attempt.idempotencyKey, `${marker.runId}:${marker.instance}`);
  await within(actAgain('claimWorkflowRun', { workflowRunId: marker.runId }), 'recovered pure run could not be claimed');
  await within(actAgain('continueWorkflowRun', { workflowRunId: marker.runId, instance: marker.instance }), 'recovered pure run did not accept continue');
  const completed = await waitFor(() => actAgain('getWorkflowRun', { workflowRunId: marker.runId }), run => run.status === 'completed', 'pure run did not complete after safe recomputation');
  assert.equal(completed.instance, marker.instance);
  assert.equal(completed.attempt.outputDigest?.length, 64);
  assert.equal(JSON.parse(await readFile(countPath, 'utf8')), 2, 'the interrupted pure attempt recomputes once after restart');
  const receipt = structuredClone(completed.attempt.outputDigest);
  await runtime.close();
  runtime = await createRuntime({ ...options, workflowActivities: [{ descriptor: pure, implementation: restartImplementation }] });
  const afterReceiptRestart = await runtime.command({ action: 'getWorkflowRun', client, workflowRunId: marker.runId });
  assert.equal(afterReceiptRestart.attempt.outputDigest, receipt);
  assert.equal(JSON.parse(await readFile(countPath, 'utf8')), 2, 'a completed pure receipt is not recomputed on a later restart');
});

test('cancelling before pure dispatch prevents the external adapter call and does not create uncertainty', async t => {
  const preparing = deferred();
  const releasePreparation = deferred();
  let dispatches = 0;
  const pure = descriptor('data.normalize-code', pureInput, pureOutput, 'pure');
  const f = await fixture(t, { workflowActivities: [{ descriptor: pure, implementation: {
    async prepare(input) { preparing.resolve(); await releasePreparation.promise; return { source: input.code }; },
    async dispatch(_context, input) { dispatches += 1; return { state: 'completed', output: { normalized: input.code } }; },
  } }] });
  f.beforeClose(() => releasePreparation.resolve());
  await f.publish('cancel-before-dispatch', [activityNode('normalize', pure.ref.id, { code: 'before' })]);
  const { workflowRunId } = await f.run('cancel-before-dispatch');
  await within(preparing.promise, 'pure activity did not reach its controlled preparation barrier');
  const active = await f.read(workflowRunId);
  await f.act('claimWorkflowRun', { workflowRunId });
  await within(f.act('cancelWorkflowRun', { workflowRunId }), 'public cancellation did not return while pure preparation was blocked');
  releasePreparation.resolve();
  const cancelled = await waitFor(() => f.read(workflowRunId), run => run.status === 'cancelled', 'run did not remain cancelled after the pending prepare returned');
  assert.equal(cancelled.instance, active.instance);
  assert.equal(dispatches, 0);
  assert.equal(cancelled.attempt.status, 'cancelled');
  const persisted = await f.state();
  const evidence = persisted.workflowEffectLedger?.[`${workflowRunId}:${active.instance}:normalize`];
  assert.ok(!evidence || evidence.status !== 'uncertain', 'pre-dispatch cancellation must not manufacture an uncertain effect');
  assert.equal(Object.keys(persisted.sessions ?? {}).length, 0);
});

test('applied durable work cancelled before acknowledgement stays uncertain through restart until matching receipt reconciliation', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'convoy-workflow-durable-receipt-'));
  const receiptFile = join(receiptDirectory, 'receipt.json');
  const entered = deferred();
  const release = deferred();
  const durable = descriptor('records.commit-batch', durableInput, durableOutput, 'durable-effect');
  const registration = { descriptor: durable, implementation: {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, batch: structuredClone(input) }; },
    async dispatch(_context, input, intent) {
      const prior = JSON.parse(await readFile(receiptFile, 'utf8').catch(() => '{"dispatches":0}'));
      const receipt = { receiptId: `receipt:${intent.requestKey}`, recordId: input.recordId, accepted: true };
      await writeFile(receiptFile, JSON.stringify({ dispatches: prior.dispatches + 1, receipt, requestKey: intent.requestKey }));
      entered.resolve();
      await release.promise;
      throw new Error('The adapter applied the batch but lost its acknowledgement.');
    },
    async reconcile(_context, input, intent, request) {
      const saved = JSON.parse(await readFile(receiptFile, 'utf8').catch(() => 'null'));
      if (request.requestedResolution === 'applied' && saved?.requestKey === intent.requestKey && saved.receipt?.recordId === input.recordId)
        return { state: 'applied', output: structuredClone(saved.receipt) };
      return { state: 'unknown', message: 'No matching durable adapter receipt exists.' };
    },
    async confirm() { return { state: 'waiting', output: { receiptId: 'pending', recordId: 'pending', accepted: false } }; },
  } };
  const f = await fixture(t, { workflowActivities: [registration] });
  t.after(() => rm(receiptDirectory, { recursive: true, force: true }));
  f.beforeClose(() => release.resolve());
  await f.publish('records-commit', [activityNode('commit', durable.ref.id, { recordId: 'records-A', quantity: 17 })]);
  const { workflowRunId } = await f.run('records-commit');
  await within(entered.promise, 'durable activity did not apply before its controlled acknowledgement barrier');
  const active = await f.read(workflowRunId);
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  const cancelled = await f.read(workflowRunId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.attempt.status, 'uncertain');
  assert.equal(cancelled.attempt.instance, active.instance);
  assert.equal(cancelled.attempt.inputDigest?.length, 64);
  const exactIntent = (await f.state()).workflowRuns[workflowRunId].attempt.intent;
  assert.equal(exactIntent.requestKey, `${workflowRunId}:${active.instance}`);

  release.resolve();
  await waitFor(async () => (await f.state()).workflowRuns[workflowRunId]?.attempt?.status,
    value => value === 'uncertain', 'durable acknowledgement loss was not retained as uncertain');
  const savedReceipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(savedReceipt.dispatches, 1);
  await f.restart();
  const afterRestart = await f.read(workflowRunId);
  assert.equal(afterRestart.status, 'cancelled');
  assert.equal(afterRestart.attempt.status, 'uncertain');
  assert.equal(afterRestart.attempt.instance, active.instance);
  assert.equal((await f.state()).workflowRuns[workflowRunId].attempt.intent.requestKey, exactIntent.requestKey);
  await f.act('claimWorkflowRun', { workflowRunId });
  await assert.rejects(f.act('continueWorkflowRun', { workflowRunId, instance: active.instance }), /uncertain|reconcile/i);
  await assert.rejects(f.act('reconcileWorkflowRun', { workflowRunId, instance: active.instance,
    effectKey: `${workflowRunId}:${active.instance}:commit`, resolution: 'applied',
    result: { receiptId: 'forged', recordId: 'other', accepted: true } }), /does not match|canonical|receipt/i);
  assert.equal((await f.read(workflowRunId)).attempt.status, 'uncertain');
  await f.act('reconcileWorkflowRun', { workflowRunId, instance: active.instance,
    effectKey: `${workflowRunId}:${active.instance}:commit`, resolution: 'applied' });
  const reconciled = await f.read(workflowRunId);
  assert.equal(reconciled.status, 'cancelled', 'settling a cancelled run must not advance its graph');
  assert.equal(reconciled.attempt.outputDigest?.length, 64);
  assert.equal((await f.state()).workflowRuns[workflowRunId].attempt.output.receiptId, `receipt:${workflowRunId}:${active.instance}`);
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).dispatches, 1, 'recovery and reconciliation never redispatch the durable effect');
  assert.equal(Object.keys((await f.state()).sessions ?? {}).length, 0);
});

test('a late confirmed durable completion after cancellation records its receipt without advancing downstream', async t => {
  const entered = deferred();
  const release = deferred();
  let firstDispatches = 0;
  let downstreamDispatches = 0;
  const durable = descriptor('records.commit-batch', durableInput, durableOutput, 'durable-effect');
  const pure = descriptor('inventory.summarize', object({ quantity: integer(0, 100_000) }, ['quantity']),
    object({ total: integer(0, 100_000) }, ['total']), 'pure');
  const f = await fixture(t, { workflowActivities: [
    { descriptor: durable, implementation: {
      async prepare(input, identity) { return { requestKey: identity.idempotencyKey, batch: structuredClone(input) }; },
      async dispatch(_context, input, intent) { firstDispatches += 1; entered.resolve(); await release.promise;
        return { state: 'completed', output: { receiptId: `receipt:${intent.requestKey}`, recordId: input.recordId, accepted: true } }; },
      async reconcile() { return { state: 'unknown' }; },
      async confirm() { return { state: 'waiting', output: { receiptId: 'pending', recordId: 'pending', accepted: false } }; },
    } },
    { descriptor: pure, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) { downstreamDispatches += 1; return { state: 'completed', output: { total: input.quantity } }; },
    } },
  ] });
  f.beforeClose(() => release.resolve());
  await f.publish('late-record-completion', [
    activityNode('commit', durable.ref.id, { recordId: 'records-B', quantity: 8 }),
    activityNode('summarize', pure.ref.id, { quantity: 8 }),
  ], [{ from: 'commit', to: 'summarize', outcome: 'success' }]);
  const { workflowRunId } = await f.run('late-record-completion');
  await within(entered.promise, 'durable activity did not reach its late-completion barrier');
  const active = await f.read(workflowRunId);
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  release.resolve();
  const settled = await waitFor(() => f.read(workflowRunId), run => run.attempt?.outputDigest, 'late activity receipt was not recorded');
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.instance, active.instance);
  assert.equal(settled.attempt.status, 'completed');
  assert.equal(settled.attempt.outputDigest?.length, 64);
  assert.equal(firstDispatches, 1);
  assert.equal(downstreamDispatches, 0);
  const persisted = await f.state();
  assert.equal(persisted.workflowRuns[workflowRunId].attempt.output.receiptId, `receipt:${workflowRunId}:${active.instance}`);
  assert.equal(Object.keys(persisted.sessions ?? {}).length, 0);
});

test('reconciling a cancelled required effect through waiting confirmation preserves cancellation and never advances', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'convoy-workflow-cancelled-waiting-receipt-'));
  const receiptFile = join(receiptDirectory, 'receipt.json');
  const durable = { ...descriptor('records.cancelled-waiting-batch', durableInput, durableOutput, 'durable-effect'),
    approval: { required: true, policy: 'workflow-gate' } };
  const pure = descriptor('inventory.cancelled-waiting-summary', object({ quantity: integer(0, 100_000) }, ['quantity']),
    object({ total: integer(0, 100_000) }, ['total']), 'pure');
  let dispatches = 0;
  let downstreamDispatches = 0;
  const registration = { descriptor: durable, implementation: {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, batch: structuredClone(input) }; },
    async dispatch(_context, input, intent) {
      dispatches += 1;
      await writeFile(receiptFile, JSON.stringify({ requestKey: intent.requestKey, recordId: input.recordId, status: 'pending' }));
      throw new Error('The batch was applied, but the acknowledgement was lost.');
    },
    async confirm(_context, input, intent) {
      return { state: 'waiting', output: { receiptId: `pending:${intent.requestKey}`, recordId: input.recordId, accepted: false } };
    },
    async reconcile(_context, input, intent) {
      const saved = JSON.parse(await readFile(receiptFile, 'utf8').catch(() => 'null'));
      if (saved?.requestKey !== intent.requestKey || saved.recordId !== input.recordId)
        return { state: 'unknown', message: 'No exact matching external receipt exists.' };
      if (saved.status === 'pending') return { state: 'waiting', effectApplied: true,
        output: { receiptId: `pending:${intent.requestKey}`, recordId: input.recordId, accepted: false } };
      if (saved.status === 'completed') return { state: 'applied',
        output: { receiptId: `completed:${intent.requestKey}`, recordId: input.recordId, accepted: true } };
      return { state: 'unknown', message: 'The exact receipt has no recognized state.' };
    },
  } };
  const f = await fixture(t, { workflowActivities: [registration, { descriptor: pure, implementation: {
    async prepare(input) { return structuredClone(input); },
    async dispatch(_context, input) { downstreamDispatches += 1; return { state: 'completed', output: { total: input.quantity } }; },
  } }] });
  t.after(() => rm(receiptDirectory, { recursive: true, force: true }));
  await f.publish('cancelled-waiting-receipt', [
    { id: 'review', name: 'Review batch', kind: 'human', prompt: 'Approve the exact record batch.' },
    activityNode('commit', durable.ref.id, { recordId: 'records-cancelled-waiting', quantity: 34 }),
    activityNode('summarize', pure.ref.id, { quantity: 34 }),
  ], [
    { from: 'review', to: 'commit', outcome: 'approved' },
    { from: 'commit', to: 'summarize', outcome: 'success' },
  ]);
  const { workflowRunId } = await f.run('cancelled-waiting-receipt');
  const gate = await f.read(workflowRunId);
  assert.equal(gate.status, 'waiting_gate');
  assert.equal(Object.keys((await f.state()).sessions ?? {}).length, 0);
  await f.act('claimWorkflowRun', { workflowRunId });
  const prepared = await f.act('prepareWorkflowActivity', { workflowRunId, gateInstance: gate.instance, targetNodeId: 'commit' });
  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest });
  const uncertain = await waitFor(() => f.read(workflowRunId), run => run.attempt?.status === 'uncertain', 'applied write did not become uncertain after acknowledgement loss');
  const instance = uncertain.instance;
  const effectKey = `${workflowRunId}:${instance}:commit`;
  assert.equal(dispatches, 1);
  const exactBeforeCancel = (await f.state()).workflowRuns[workflowRunId].attempt;
  assert.equal(exactBeforeCancel.reservationId, prepared.id);
  await f.act('cancelWorkflowRun', { workflowRunId });
  const cancelled = await f.read(workflowRunId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.attempt.status, 'uncertain');
  await f.act('reconcileWorkflowRun', { workflowRunId, instance, effectKey, resolution: 'applied' });
  const waiting = await f.read(workflowRunId);
  assert.equal(waiting.status, 'cancelled', 'an applied-but-waiting receipt must not reopen a cancelled run');
  assert.equal(waiting.instance, instance);
  assert.equal(waiting.attempt.status, 'waiting');
  assert.equal(dispatches, 1);
  assert.equal(downstreamDispatches, 0);
  const pendingState = await f.state();
  const pendingAttempt = pendingState.workflowRuns[workflowRunId].attempt;
  assert.deepEqual(pendingAttempt.waitingOutput, { receiptId: `pending:${workflowRunId}:${instance}`, recordId: 'records-cancelled-waiting', accepted: false });
  assert.equal(pendingAttempt.reservationId, prepared.id);
  await assert.rejects(f.act('continueWorkflowRun', { workflowRunId, instance }), /cancelled|not waiting|not active/i);

  await writeFile(receiptFile, JSON.stringify({ requestKey: `${workflowRunId}:${instance}`, recordId: 'records-cancelled-waiting', status: 'completed' }));
  await f.act('reconcileWorkflowRun', { workflowRunId, instance, effectKey, resolution: 'applied' });
  const completedReceipt = await f.read(workflowRunId);
  assert.equal(completedReceipt.status, 'cancelled', 'a later completed adapter receipt does not undo cancellation');
  assert.equal(completedReceipt.instance, instance);
  assert.equal(completedReceipt.attempt.status, 'completed');
  assert.equal(dispatches, 1, 'both reconciliations inspect the same original effect without replay');
  assert.equal(downstreamDispatches, 0, 'cancellation continues to fence every downstream graph transition');
  const finalState = await f.state();
  assert.deepEqual(finalState.workflowRuns[workflowRunId].attempt.output,
    { receiptId: `completed:${workflowRunId}:${instance}`, recordId: 'records-cancelled-waiting', accepted: true });
  assert.equal(finalState.workflowRuns[workflowRunId].attempt.reservationId, prepared.id);
  assert.equal(finalState.workflowRuns[workflowRunId].activityReservations.find(value => value.id === prepared.id).digest, prepared.digest);
  assert.equal(Object.keys(finalState.sessions ?? {}).length, 0);
});

test('an approved durable activity reconciles its exact persisted intent after acknowledgement loss and restart', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'convoy-workflow-approved-receipt-'));
  const receiptFile = join(receiptDirectory, 'receipt.json');
  const dispatchCount = join(receiptDirectory, 'dispatch-count.json');
  const durable = { ...descriptor('procurement.authorize-order',
    object({ orderId: string(80), amount: integer(1, 100_000) }, ['orderId', 'amount']),
    object({ receiptId: string(160), orderId: string(80), approved: { type: 'boolean' } }, ['receiptId', 'orderId', 'approved']), 'durable-effect'),
  approval: { required: true, policy: 'workflow-gate' } };
  const registration = { descriptor: durable, implementation: {
    async prepare(input, identity) { return { request: { ...structuredClone(input), idempotencyKey: identity.idempotencyKey } }; },
    async dispatch(_context, input, intent) {
      const count = Number(await readFile(dispatchCount, 'utf8').catch(() => '0'));
      await writeFile(dispatchCount, String(count + 1));
      const receipt = { receiptId: `approved:${intent.request.idempotencyKey}`, orderId: input.orderId, approved: true };
      await writeFile(receiptFile, JSON.stringify({ key: intent.request.idempotencyKey, receipt }));
      throw new Error('The approved order was applied but its acknowledgement was lost.');
    },
    async confirm() { return { state: 'waiting', output: { receiptId: 'pending', orderId: 'pending', approved: false } }; },
    async reconcile(_context, input, intent) {
      const saved = JSON.parse(await readFile(receiptFile, 'utf8').catch(() => 'null'));
      if (saved?.key === intent.request.idempotencyKey && saved.receipt?.orderId === input.orderId)
        return { state: 'applied', output: structuredClone(saved.receipt) };
      return { state: 'unknown', message: 'No canonical matching order receipt exists.' };
    },
  } };
  const f = await fixture(t, { workflowActivities: [registration] });
  t.after(() => rm(receiptDirectory, { recursive: true, force: true }));
  await f.publish('approved-order', [
    { id: 'review', name: 'Review order', kind: 'human', prompt: 'Review this exact purchase order.' },
    activityNode('authorize', durable.ref.id, { orderId: 'PO-442', amount: 1840 }),
  ], [{ from: 'review', to: 'authorize', outcome: 'approved' }]);
  const { workflowRunId } = await f.run('approved-order');
  const gate = await f.read(workflowRunId);
  assert.equal(gate.status, 'waiting_gate');
  assert.equal(Object.keys((await f.state()).sessions ?? {}).length, 0);
  await f.act('claimWorkflowRun', { workflowRunId });
  const reservation = await f.act('prepareWorkflowActivity', { workflowRunId, gateInstance: gate.instance, targetNodeId: 'authorize' });
  assert.equal((await f.state()).workflowRuns[workflowRunId].activityReservations.find(value => value.id === reservation.id).targetNodeId, 'authorize');
  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: reservation.id, activityReservationDigest: reservation.digest });
  const uncertain = await waitFor(() => f.read(workflowRunId), run => run.status === 'failed', 'approved effect did not enter recovery state');
  assert.equal(uncertain.attempt.status, 'uncertain');
  const instance = uncertain.instance;
  const effectKey = `${workflowRunId}:${instance}:authorize`;
  const durableIntent = (await f.state()).workflowRuns[workflowRunId].attempt.intent;
  assert.equal(durableIntent.request.idempotencyKey, `${workflowRunId}:${instance}`);
  assert.equal(Number(await readFile(dispatchCount, 'utf8')), 1);
  await f.restart();
  const recovered = await f.read(workflowRunId);
  assert.equal(recovered.instance, instance);
  assert.equal(recovered.attempt.status, 'uncertain');
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('reconcileWorkflowRun', { workflowRunId, instance, effectKey, resolution: 'applied' });
  const completed = await waitFor(() => f.read(workflowRunId), run => run.status === 'completed', 'approved receipt did not complete after exact reconciliation');
  assert.equal(completed.attempt.instance, instance);
  assert.equal(completed.attempt.outputDigest?.length, 64);
  assert.deepEqual((await f.state()).workflowRuns[workflowRunId].attempt.output,
    { receiptId: `approved:${workflowRunId}:${instance}`, orderId: 'PO-442', approved: true });
  assert.equal(Number(await readFile(dispatchCount, 'utf8')), 1, 'reconciliation after restart does not redispatch the approved effect');
  assert.equal(Object.keys((await f.state()).sessions ?? {}).length, 0);
});

test('a workflow-approved waiting activity confirms under the original reservation without redispatch', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'convoy-workflow-approved-waiting-'));
  const durable = { ...descriptor('procurement.confirm-authorized-order', durableInput, durableOutput, 'durable-effect'),
    approval: { required: true, policy: 'workflow-gate' } };
  let dispatches = 0;
  let confirmations = 0;
  const registration = { descriptor: durable, implementation: {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, request: structuredClone(input) }; },
    async dispatch(_context, input, intent) {
      dispatches += 1;
      assert.deepEqual(input, { recordId: 'records-approved-waiting', quantity: 13 });
      return { state: 'waiting', output: { receiptId: `pending:${intent.requestKey}`, recordId: input.recordId, accepted: false } };
    },
    async confirm(_context, input, intent) {
      confirmations += 1;
      return { state: 'completed', output: { receiptId: `confirmed:${intent.requestKey}`, recordId: input.recordId, accepted: true } };
    },
    async reconcile() { return { state: 'unknown', message: 'The activity is awaiting its canonical confirmation.' }; },
  } };
  const f = await fixture(t, { workflowActivities: [registration] });
  t.after(() => rm(receiptDirectory, { recursive: true, force: true }));
  await f.publish('approved-waiting-order', [
    { id: 'review', name: 'Review order', kind: 'human', prompt: 'Approve the exact purchase order.' },
    activityNode('authorize', durable.ref.id, { recordId: 'records-approved-waiting', quantity: 13 }),
  ], [{ from: 'review', to: 'authorize', outcome: 'approved' }]);
  const { workflowRunId } = await f.run('approved-waiting-order');
  const gate = await f.read(workflowRunId);
  assert.equal(gate.status, 'waiting_gate');
  await f.act('claimWorkflowRun', { workflowRunId });
  const prepared = await f.act('prepareWorkflowActivity', { workflowRunId, gateInstance: gate.instance, targetNodeId: 'authorize' });
  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest });
  const waiting = await waitFor(() => f.read(workflowRunId), run => run.attempt?.status === 'waiting', 'approved dispatch did not enter waiting confirmation');
  assert.equal(waiting.status, 'paused');
  assert.equal(dispatches, 1);
  assert.equal(confirmations, 0);
  const waitingState = await f.state();
  const waitingAttempt = waitingState.workflowRuns[workflowRunId].attempt;
  const exactInstance = waitingAttempt.instance;
  const exactInputDigest = waitingAttempt.inputDigest;
  const exactIntentDigest = waitingAttempt.intentDigest;
  const exactIdempotencyKey = waitingAttempt.idempotencyKey;
  const exactReservationId = waitingAttempt.reservationId;
  assert.equal(exactReservationId, prepared.id);
  assert.equal(exactIdempotencyKey, `${workflowRunId}:${exactInstance}`);
  await f.act('continueWorkflowRun', { workflowRunId, instance: exactInstance });
  const completed = await waitFor(() => f.read(workflowRunId), run => ['completed', 'failed', 'interrupted'].includes(run.status), 'approved wait did not settle after confirmation');
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.attempt.instance, exactInstance);
  assert.equal(completed.attempt.status, 'completed');
  assert.equal(completed.attempt.inputDigest, exactInputDigest);
  assert.equal(completed.attempt.idempotencyKey, exactIdempotencyKey);
  assert.equal(dispatches, 1, 'continue confirms the original write instead of dispatching it again');
  assert.equal(confirmations, 1);
  const finalState = await f.state();
  const finalAttempt = finalState.workflowRuns[workflowRunId].attempt;
  assert.equal(finalAttempt.intentDigest, exactIntentDigest);
  assert.equal(finalAttempt.reservationId, exactReservationId);
  assert.deepEqual(finalAttempt.output,
    { receiptId: `confirmed:${exactIdempotencyKey}`, recordId: 'records-approved-waiting', accepted: true });
  assert.equal(finalState.workflowRuns[workflowRunId].activityReservations.find(value => value.id === prepared.id).consumedAt !== undefined, true);
  assert.equal(Object.keys(finalState.sessions ?? {}).length, 0);
});

test('a required activity retry reuses its exact human approval only after adapter proves not_applied', async t => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'convoy-workflow-approved-retry-'));
  const durable = { ...descriptor('procurement.retry-authorized-order', durableInput, durableOutput, 'durable-effect'),
    approval: { required: true, policy: 'workflow-gate' } };
  let dispatches = 0;
  let applies = 0;
  let proveNotApplied = false;
  const dispatchIdentities = [];
  const registration = { descriptor: durable, implementation: {
    async prepare(input, identity) { return { requestKey: identity.idempotencyKey, request: structuredClone(input) }; },
    async dispatch(_context, input, intent) {
      dispatches += 1;
      dispatchIdentities.push({ requestKey: intent.requestKey, input: structuredClone(input) });
      if (dispatches === 1) throw new Error('Connection failed before the adapter applied the order.');
      applies += 1;
      return { state: 'completed', output: { receiptId: `applied:${intent.requestKey}`, recordId: input.recordId, accepted: true } };
    },
    async confirm() { return { state: 'uncertain', message: 'No confirmation is available for this attempt.' }; },
    async reconcile(_context, _input, intent) {
      if (!proveNotApplied) return { state: 'unknown', message: 'The adapter has not established whether the first request applied.' };
      return { state: 'not_applied', message: `The adapter confirms ${intent.requestKey} was not applied.` };
    },
  } };
  const f = await fixture(t, { workflowActivities: [registration] });
  t.after(() => rm(receiptDirectory, { recursive: true, force: true }));
  await f.publish('approved-retry-order', [
    { id: 'review', name: 'Review order', kind: 'human', prompt: 'Approve the exact purchase order.' },
    activityNode('authorize', durable.ref.id, { recordId: 'records-approved-retry', quantity: 21 }),
  ], [{ from: 'review', to: 'authorize', outcome: 'approved' }]);
  const { workflowRunId } = await f.run('approved-retry-order');
  const gate = await f.read(workflowRunId);
  assert.equal(gate.status, 'waiting_gate');
  await f.act('claimWorkflowRun', { workflowRunId });
  const prepared = await f.act('prepareWorkflowActivity', { workflowRunId, gateInstance: gate.instance, targetNodeId: 'authorize' });
  await f.act('decideWorkflowRun', { workflowRunId, instance: gate.instance, decision: 'approve',
    activityReservationId: prepared.id, activityReservationDigest: prepared.digest });
  const uncertain = await waitFor(() => f.read(workflowRunId), run => run.attempt?.status === 'uncertain', 'pre-effect failure did not remain uncertain');
  assert.equal(uncertain.status, 'failed');
  assert.equal(dispatches, 1);
  assert.equal(applies, 0);
  const firstState = await f.state();
  const firstAttempt = firstState.workflowRuns[workflowRunId].attempt;
  const exactInstance = firstAttempt.instance;
  const exactInputDigest = firstAttempt.inputDigest;
  const exactIntentDigest = firstAttempt.intentDigest;
  const exactIdempotencyKey = firstAttempt.idempotencyKey;
  const exactReservationId = firstAttempt.reservationId;
  const effectKey = `${workflowRunId}:${exactInstance}:authorize`;
  assert.equal(exactReservationId, prepared.id);
  assert.equal(exactIdempotencyKey, `${workflowRunId}:${exactInstance}`);
  await assert.rejects(f.act('continueWorkflowRun', { workflowRunId, instance: exactInstance }), /uncertain|reconcile/i,
    'the run cannot retry until the adapter gives canonical non-application proof');
  await assert.rejects(f.act('reconcileWorkflowRun', { workflowRunId, instance: exactInstance, effectKey, resolution: 'not_applied' }),
    /cannot confirm|canonical/i, 'an unknown adapter outcome cannot authorize a retry');
  assert.equal((await f.read(workflowRunId)).attempt.status, 'uncertain', 'adapter unknown leaves the exact approved attempt uncertain');
  assert.equal(dispatches, 1);
  proveNotApplied = true;
  await f.act('reconcileWorkflowRun', { workflowRunId, instance: exactInstance, effectKey, resolution: 'not_applied' });
  const proven = await f.read(workflowRunId);
  assert.equal(proven.attempt.status, 'ready');
  assert.equal(proven.instance, exactInstance);
  assert.equal(proven.attempt.inputDigest, exactInputDigest);
  assert.equal(proven.attempt.idempotencyKey, exactIdempotencyKey);
  const provenAttempt = (await f.state()).workflowRuns[workflowRunId].attempt;
  assert.equal(provenAttempt.reservationId, exactReservationId);
  assert.equal(provenAttempt.intentDigest, exactIntentDigest);
  assert.equal(dispatches, 1, 'adapter proof alone does not implicitly replay the write');
  await f.act('continueWorkflowRun', { workflowRunId, instance: exactInstance });
  const completed = await waitFor(() => f.read(workflowRunId), run => ['completed', 'failed', 'interrupted'].includes(run.status), 'authorized retry did not settle');
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.instance, exactInstance);
  assert.equal(completed.attempt.inputDigest, exactInputDigest);
  assert.equal(completed.attempt.idempotencyKey, exactIdempotencyKey);
  assert.equal(dispatches, 2);
  assert.equal(applies, 1);
  assert.deepEqual(dispatchIdentities, [
    { requestKey: exactIdempotencyKey, input: { recordId: 'records-approved-retry', quantity: 21 } },
    { requestKey: exactIdempotencyKey, input: { recordId: 'records-approved-retry', quantity: 21 } },
  ], 'retry consumes the same approved input, intent key and gate reservation');
  const finalState = await f.state();
  const finalAttempt = finalState.workflowRuns[workflowRunId].attempt;
  assert.equal(finalAttempt.reservationId, exactReservationId);
  assert.equal(finalAttempt.intentDigest, exactIntentDigest);
  const savedReservation = finalState.workflowRuns[workflowRunId].activityReservations.find(value => value.id === prepared.id);
  assert.equal(savedReservation.digest, prepared.digest);
  assert.equal(savedReservation.targetInstance, exactInstance);
  assert.equal(savedReservation.targetNodeId, 'authorize');
  assert.equal(finalState.workflowEffectLedger[effectKey].resolution, 'not_applied');
  assert.equal(Object.keys(finalState.sessions ?? {}).length, 0);
});

test('restart advances a persisted completed activity receipt without redispatching across the transition gap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-completed-receipt-gap-'));
  const markerPath = join(directory, 'receipt-persisted.json');
  const failurePath = join(directory, 'child-error.txt');
  const countsPath = join(directory, 'dispatch-counts.json');
  const client = 'workflow-completed-receipt-gap';
  const runtimePath = pathToFileURL(new URL('../../apps/daemon/src/bootstrap/runtime-factory.mjs', import.meta.url).pathname).href;
  const controlRuntimePath = pathToFileURL(new URL('../../apps/daemon/src/control-plane/runtime.mjs', import.meta.url).pathname).href;
  const persistencePath = pathToFileURL(new URL('../../apps/daemon/src/adapters/persistence/index.mjs', import.meta.url).pathname).href;
  const schemaPath = pathToFileURL(new URL('../../apps/daemon/src/control-plane/state-schema.mjs', import.meta.url).pathname).href;
  const workflowsPath = pathToFileURL(new URL('../../apps/daemon/src/modules/workflows/index.mjs', import.meta.url).pathname).href;
  const first = descriptor('data.normalize-code', pureInput, pureOutput, 'pure');
  const secondInput = object({ label: string(40) }, ['label']);
  const secondOutput = object({ label: string(40) }, ['label']);
  const second = descriptor('inventory.summarize', secondInput, secondOutput, 'pure');
  const registrations = [first, second];
  let child;
  let runtime;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([processExit(child), new Promise(resolve => setTimeout(resolve, 1000))]);
      child.unref();
      child.stderr?.destroy();
    }
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const activityImplementations = [
    { descriptor: first, implementation: {
      async prepare(input) { return { source: input.code }; },
      async dispatch(_context, input, intent) {
        const counts = JSON.parse(await readFile(countsPath, 'utf8').catch(() => '{}'));
        counts.normalize = (counts.normalize ?? 0) + 1;
        await writeFile(countsPath, JSON.stringify(counts));
        return { state: 'completed', output: { normalized: `${intent.source}:${input.code}` } };
      },
    } },
    { descriptor: second, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) {
        const counts = JSON.parse(await readFile(countsPath, 'utf8').catch(() => '{}'));
        counts.summarize = (counts.summarize ?? 0) + 1;
        await writeFile(countsPath, JSON.stringify(counts));
        return { state: 'completed', output: structuredClone(input) };
      },
    } },
  ];
  const options = {
    directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Pure activities do not call providers.'); },
    runners: { execute: async () => { assert.fail('Pure activities do not call runners.'); }, close: async () => {} },
    workflowActivities: activityImplementations,
  };
  runtime = await createRuntime(options);
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const org = await act('createOrganization', { slug: `receipt-gap-${Date.now()}`, displayName: 'Receipt gap test', kind: 'team' });
  const project = await act('saveProject', { organizationId: org.id, name: 'Receipt gap' });
  await act('selectActiveContext', { context: { organizationId: org.id, projectId: project.id } });
  await act('saveWorkflow', { projectId: project.id, workflow: { id: 'receipt-gap', name: 'Receipt gap', nodes: [
    activityNode('normalize', first.ref.id, { code: 'stable' }),
    { id: 'summarize', name: 'Summarize', kind: 'action', activity: second.ref,
      bindings: { label: { from: { kind: 'activity_output', nodeId: 'normalize', path: ['normalized'] } } } },
  ], edges: [{ from: 'normalize', to: 'summarize', outcome: 'success' }] } });
  const version = (await runtime.snapshot(undefined, client)).workflows.find(value => value.id === 'receipt-gap').version;
  await runtime.close();
  runtime = null;

  const childSource = `
    import { writeFile, readFile } from 'node:fs/promises';
    import { createPersistence } from ${JSON.stringify(persistencePath)};
    import { createRuntime } from ${JSON.stringify(controlRuntimePath)};
    import { initialControlPlaneState } from ${JSON.stringify(schemaPath)};
    import { defaultWorkflowDefinition } from ${JSON.stringify(workflowsPath)};
    const [directory, client, projectId, workflowVersion, markerPath, failurePath] = process.argv.slice(1);
    const descriptors = ${JSON.stringify(registrations)};
    const implementations = [
      { descriptor: descriptors[0], implementation: {
        async prepare(input) { return { source: input.code }; },
        async dispatch(_context, input, intent) {
          const path = ${JSON.stringify(countsPath)};
          const counts = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
          counts.normalize = (counts.normalize ?? 0) + 1;
          await writeFile(path, JSON.stringify(counts));
          return { state: 'completed', output: { normalized: intent.source + ':' + input.code } };
        },
      } },
      { descriptor: descriptors[1], implementation: {
        async prepare(input) { return input; },
        async dispatch(_context, input) {
          const path = ${JSON.stringify(countsPath)};
          const counts = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
          counts.summarize = (counts.summarize ?? 0) + 1;
          await writeFile(path, JSON.stringify(counts));
          return { state: 'completed', output: input };
        },
      } },
    ];
    try {
      const persistence = await createPersistence({ directory, initialState: initialControlPlaneState(defaultWorkflowDefinition) });
      const store = persistence.store;
      const save = store.save.bind(store);
      let blocked = false;
      store.save = async () => {
        const saved = await save();
        const run = Object.values(store.data.workflowRuns ?? {}).find(value => value.independentRun && value.attempt?.activityRef?.id === 'data.normalize-code');
        if (!blocked && run?.attempt.status === 'completed' && run.flow?.status === 'running') {
          blocked = true;
          await writeFile(markerPath, JSON.stringify({ runId: run.id, instance: run.attempt.instance, outputDigest: run.attempt.outputDigest }));
          await new Promise(() => {});
        }
        return saved;
      };
      const runtime = await createRuntime({ persistence, models: [{ id: 'fixture' }],
        auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
        generate: async function* () { throw new Error('Pure activities do not call providers.'); },
        runners: { execute: async () => { throw new Error('Pure activities do not call runners.'); }, close: async () => {} },
        workflowActivities: implementations });
      await runtime.command({ action: 'startWorkflowRun', client, projectId, workflowId: 'receipt-gap', workflowVersion: Number(workflowVersion) });
      await new Promise(() => {});
    } catch (error) {
      await writeFile(failurePath, String(error?.stack ?? error));
      process.exitCode = 1;
    }
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', childSource,
    directory, client, project.id, version, markerPath, failurePath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { childError += chunk; });
  const signal = await waitFor(async () => {
    try { return { marker: JSON.parse(await readFile(markerPath, 'utf8')) }; } catch {}
    try { return { error: await readFile(failurePath, 'utf8') }; } catch { return null; }
  }, value => Boolean(value?.marker?.runId || value?.error), 'child did not persist the completed activity receipt');
  if (signal.error) throw new Error(`Child runtime failed before receipt persistence: ${signal.error}; stderr=${childError}`);
  const persistedBeforeCrash = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const storedRun = persistedBeforeCrash.workflowRuns[signal.marker.runId];
  assert.equal(storedRun.flow.status, 'running');
  assert.equal(storedRun.attempt.status, 'completed');
  assert.equal(storedRun.attempt.instance, signal.marker.instance);
  assert.equal(storedRun.attempt.outputDigest, signal.marker.outputDigest);
  assert.equal(JSON.parse(await readFile(countsPath, 'utf8')).normalize, 1);
  child.kill('SIGKILL');
  await within(processExit(child), 'receipt-gap child did not exit after crash');
  child = null;

  runtime = await createRuntime(options);
  const resumed = (action, fields = {}) => runtime.command({ action, client, ...fields });
  const recovered = await resumed('getWorkflowRun', { workflowRunId: signal.marker.runId });
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.attempt.status, 'completed');
  assert.equal(recovered.attempt.instance, signal.marker.instance);
  assert.equal(recovered.attempt.outputDigest, signal.marker.outputDigest);
  await resumed('claimWorkflowRun', { workflowRunId: signal.marker.runId });
  await resumed('continueWorkflowRun', { workflowRunId: signal.marker.runId, instance: signal.marker.instance });
  const completed = await waitFor(() => resumed('getWorkflowRun', { workflowRunId: signal.marker.runId }),
    run => run.status === 'completed', 'run did not advance its cached output after restart');
  assert.equal(completed.history.find(entry => entry.nodeId === 'normalize').instance, signal.marker.instance);
  assert.equal(completed.attempt.activityRef.id, 'inventory.summarize');
  const completedState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(completedState.workflowRuns[signal.marker.runId].activityOutputs.normalize.value, { normalized: 'stable:stable' });
  assert.deepEqual(completedState.workflowRuns[signal.marker.runId].attempt.output, { label: 'stable:stable' });
  assert.deepEqual(JSON.parse(await readFile(countsPath, 'utf8')), { normalize: 1, summarize: 1 });
  assert.equal(Object.keys((await runtime.snapshot(undefined, client)).sessions ?? {}).length, 0);
  await runtime.close();
  runtime = null;
});
