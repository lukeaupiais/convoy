import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createProviderAdapterRegistry } from '../../apps/daemon/src/adapters/providers/registry.mjs';

const defaults = {
  maxDescendantRuns: 128,
  maxMapItems: 100,
  maxConcurrentChildren: 8,
  maxDeadlineMs: 604_800_000,
  maxActiveDescendantRuns: 32,
  maxActiveDescendantsPerRoot: 8,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(read, predicate, message, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

function echoRegistration(barriers) {
  const started = [];
  const active = new Set();
  let completeAutomatically = false;
  const descriptor = {
    ref: { id: 'composition.echo-item', revision: 1 },
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', maxLength: 80 },
        position: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['item', 'position'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', maxLength: 80 },
        position: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['item', 'position'],
      additionalProperties: false,
    },
    resources: { location: 'integration', adapterId: 'composition-acceptance' },
    effect: 'pure',
    approval: { required: false },
    cancellation: 'immediate',
    confirmation: 'result',
    reconciliation: 'none',
    presentation: { label: 'Echo configured item' },
  };
  const implementation = {
    async prepare(input) {
      return { item: input.item };
    },
    async dispatch(_context, input, _intent, signal) {
      started.push(input.item);
      active.add(input.item);
      if (completeAutomatically) {
        active.delete(input.item);
        return { state: 'completed', output: { item: input.item, position: input.position } };
      }
      const slot = deferred();
      barriers.set(input.item, slot);
      if (signal.aborted) return { state: 'failed', message: 'Pure child stopped.' };
      signal.addEventListener(
        'abort',
        () => slot.resolve({ state: 'failed', message: 'Pure child stopped.' }),
        { once: true },
      );
      return slot.promise.then((result) => {
        active.delete(input.item);
        return result;
      });
    },
  };
  return {
    descriptor,
    implementation,
    started,
    active,
    release(item) {
      const position = Number(item.split('-').at(-1)) - 1;
      barriers.get(item)?.resolve({ state: 'completed', output: { item, position } });
    },
    completeAutomatically() {
      completeAutomatically = true;
    },
  };
}

async function fixture(t, { workflowActivities = [], beforeClose = [], generate, runtimeOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-composition-policy-'));
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: generate ?? (async function* () {
      assert.fail('No composition-policy setup should invoke a provider.');
    }),
    runners: {
      execute: async () => {
        assert.fail('No composition-policy setup should acquire a runner.');
      },
      close: async () => {},
    },
    workflowActivities,
    ...runtimeOptions,
  };
  let runtime = await createRuntime(options);
  t.after(async () => {
    for (const cleanup of beforeClose) await cleanup();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const act = (action, fields = {}, principal) =>
    runtime.command(
      { action, client: 'workflow-composition-policy-acceptance', ...fields },
      principal,
    );
  const organization = await act('createOrganization', {
    slug: `composition-policy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Composition policy acceptance',
    kind: 'team',
  });
  const projectA = await act('saveProject', {
    organizationId: organization.id,
    name: 'Inventory review',
  });
  const projectB = await act('saveProject', {
    organizationId: organization.id,
    name: 'Publication review',
  });
  await act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: projectA.id },
  });
  return {
    act,
    organization,
    projectA,
    projectB,
    snapshot: async (principal) =>
      runtime.snapshot(undefined, 'workflow-composition-policy-acceptance', principal),
    readRun: (workflowRunId) => act('getWorkflowRun', { workflowRunId }),
    readState: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')),
    async restart() {
      await runtime.close();
      runtime = await createRuntime(options);
    },
  };
}

function echoChildWorkflow(projectId) {
  const schema = {
    type: 'object',
    properties: {
      item: { type: 'string', maxLength: 80 },
      position: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['item', 'position'],
    additionalProperties: false,
  };
  return {
    id: `echo-child-${projectId}`,
    name: `Echo child ${projectId}`,
    projectId,
    runInputSchema: schema,
    resultSchema: schema,
    resultBindings: {
      item: { from: { kind: 'activity_output', nodeId: 'echo', path: ['item'] } },
      position: { from: { kind: 'activity_output', nodeId: 'echo', path: ['position'] } },
    },
    nodes: [
      {
        id: 'echo',
        name: 'Echo item',
        kind: 'action',
        activity: { id: 'composition.echo-item', revision: 1 },
        bindings: {
          item: { from: { kind: 'run_input', path: ['item'] } },
          position: { from: { kind: 'run_input', path: ['position'] } },
        },
      },
    ],
    edges: [],
  };
}

function mapWorkflow(projectId, childWorkflowId) {
  return {
    id: `map-parent-${projectId}`,
    name: `Map parent ${projectId}`,
    projectId,
    runInputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string', maxLength: 80 },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    nodes: [
      {
        id: 'map-items',
        name: 'Map configured items',
        kind: 'map',
        itemsBinding: { from: { kind: 'run_input', path: ['items'] } },
        itemField: 'item',
        indexField: 'position',
        workflow: { id: childWorkflowId, version: 1 },
        inputBindings: {},
        outputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', maxLength: 80 },
              position: { type: 'integer', minimum: 0, maximum: 3 },
            },
            required: ['item', 'position'],
            additionalProperties: false,
          },
        },
        outputBindings: {
          item: { from: ['item'] },
          position: { from: ['position'] },
        },
        maxItems: 4,
        maxConcurrent: 2,
        deadlineMs: 60_000,
        failurePolicy: 'fail_fast',
      },
    ],
    edges: [],
  };
}

function durableMapChildWorkflow(projectId, activityId) {
  const schema = {
    type: 'object',
    properties: {
      item: { type: 'string', maxLength: 80 },
      position: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['item', 'position'],
    additionalProperties: false,
  };
  return {
    id: `durable-map-child-${projectId}`,
    name: `Durable map child ${projectId}`,
    projectId,
    runInputSchema: schema,
    resultSchema: schema,
    resultBindings: {
      item: { from: { kind: 'activity_output', nodeId: 'write', path: ['item'] } },
      position: { from: { kind: 'activity_output', nodeId: 'write', path: ['position'] } },
    },
    nodes: [
      {
        id: 'write',
        name: 'Write item',
        kind: 'action',
        activity: { id: activityId, revision: 1 },
        bindings: {
          item: { from: { kind: 'run_input', path: ['item'] } },
          position: { from: { kind: 'run_input', path: ['position'] } },
        },
      },
    ],
    edges: [],
  };
}

function durableMapRegistration(receipts, dispatches) {
  const schema = {
    type: 'object',
    properties: {
      item: { type: 'string', maxLength: 80 },
      position: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['item', 'position'],
    additionalProperties: false,
  };
  return {
    descriptor: {
      ref: { id: 'composition.durable-write-item', revision: 1 },
      inputSchema: schema,
      outputSchema: schema,
      resources: { location: 'integration', adapterId: 'composition-durable-acceptance' },
      effect: 'durable-effect',
      approval: { required: false },
      cancellation: 'reconcile-after-dispatch',
      confirmation: 'adapter-confirmed',
      reconciliation: 'adapter',
      presentation: { label: 'Durably write item' },
    },
    implementation: {
      async prepare(input, identity) {
        return { requestKey: identity.idempotencyKey, input: structuredClone(input) };
      },
      async dispatch(_context, input, intent) {
        dispatches.push({ requestKey: intent.requestKey, input: structuredClone(input) });
        receipts.set(intent.requestKey, { item: input.item, position: input.position });
        throw new Error('The durable item was accepted, but its acknowledgement was lost.');
      },
      async confirm() {
        return { state: 'waiting' };
      },
      async reconcile(_context, input, intent, request) {
        const receipt = receipts.get(intent.requestKey);
        return request.requestedResolution === 'applied' && receipt && receipt.item === input.item
          ? { state: 'applied', output: structuredClone(receipt) }
          : { state: 'unknown', message: 'No canonical matching item receipt is available.' };
      },
    },
  };
}

function firstSuccessWorkflow(projectId, childWorkflowId, successorActivityId) {
  const winnerSchema = {
    type: 'object',
    properties: { winner: { type: 'string', maxLength: 80 } },
    required: ['winner'],
    additionalProperties: false,
  };
  return {
    id: `first-success-${projectId}`,
    name: `First success ${projectId}`,
    projectId,
    nodes: [
      {
        id: 'race',
        name: 'Race candidates',
        kind: 'parallel',
        join: 'first_success',
        maxConcurrent: 2,
        deadlineMs: 60_000,
        outputSchema: winnerSchema,
        branches: ['slow', 'fast'].map((item, index) => ({
          id: item,
          workflow: { id: childWorkflowId, version: 1 },
          inputBindings: { item: { literal: item }, position: { literal: index } },
          outputBindings: { winner: { from: ['item'] } },
        })),
      },
      {
        id: 'follow',
        name: 'Use the winning result',
        kind: 'action',
        activity: { id: successorActivityId, revision: 1 },
        bindings: {
          winner: { from: { kind: 'activity_output', nodeId: 'race', path: ['winner'] } },
        },
      },
    ],
    edges: [{ from: 'race', to: 'follow', outcome: 'success' }],
  };
}

function nestedMapWorkflows(projectId, leafWorkflowId, rootSuffix) {
  const schema = {
    type: 'object',
    properties: {
      item: { type: 'string', maxLength: 80 },
      position: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['item', 'position'],
    additionalProperties: false,
  };
  const inner = {
    id: `nested-map-${rootSuffix}`,
    name: `Nested map ${rootSuffix}`,
    projectId,
    runInputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string', maxLength: 80 },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    resultSchema: schema,
    resultBindings: {
      item: { from: { kind: 'activity_output', nodeId: 'map-leaves', path: ['0', 'item'] } },
      position: {
        from: { kind: 'activity_output', nodeId: 'map-leaves', path: ['0', 'position'] },
      },
    },
    nodes: [
      {
        id: 'map-leaves',
        name: 'Map leaves',
        kind: 'map',
        itemsBinding: { from: { kind: 'run_input', path: ['items'] } },
        itemField: 'item',
        indexField: 'position',
        workflow: { id: leafWorkflowId, version: 1 },
        inputBindings: {},
        outputSchema: {
          type: 'array',
          items: schema,
        },
        outputBindings: {
          item: { from: ['item'] },
          position: { from: ['position'] },
        },
        maxItems: 2,
        maxConcurrent: 2,
        deadlineMs: 60_000,
        failurePolicy: 'fail_fast',
      },
    ],
    edges: [],
  };
  const root = {
    id: `nested-root-${rootSuffix}`,
    name: `Nested root ${rootSuffix}`,
    projectId,
    nodes: [
      {
        id: 'coordinate',
        name: 'Coordinate nested workflow',
        kind: 'child',
        workflow: { id: inner.id, version: 1 },
        inputBindings: { items: { literal: [`${rootSuffix}-leaf-1`, `${rootSuffix}-leaf-2`] } },
        outputSchema: schema,
        outputBindings: {
          item: { from: ['item'] },
          position: { from: ['position'] },
        },
      },
    ],
    edges: [],
  };
  return { inner, root };
}

test('composition ceilings are scoped independently to an organization and its projects', async (t) => {
  const f = await fixture(t);
  const organizationLimits = { ...defaults, maxActiveDescendantRuns: 2 };
  const projectALimits = {
    ...organizationLimits,
    maxConcurrentChildren: 5,
    maxActiveDescendantRuns: 1,
  };
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: organizationLimits,
  });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    projectId: f.projectA.id,
    baseRevision: 0,
    limits: projectALimits,
  });

  const policies = (await f.snapshot()).workflowCompositionPolicies;
  assert.deepEqual(policies.organizations[f.organization.id], {
    revision: 1,
    limits: organizationLimits,
  });
  assert.deepEqual(policies.projects[f.projectA.id], {
    organizationId: f.organization.id,
    revision: 1,
    limits: projectALimits,
  });
  assert.equal(
    Object.hasOwn(policies.projects, f.projectB.id),
    false,
    'an override for Inventory review must not become Publication review policy',
  );
  await assert.rejects(
    f.act('setWorkflowCompositionPolicy', {
      organizationId: f.organization.id,
      projectId: f.projectB.id,
      baseRevision: 0,
      limits: { ...organizationLimits, maxActiveDescendantRuns: 3 },
    }),
    /cannot exceed organization/i,
  );
  await assert.rejects(
    f.act('setWorkflowCompositionPolicy', {
      organizationId: f.organization.id,
      baseRevision: 0,
      limits: organizationLimits,
    }),
    /changed|reload/i,
    'stale organization policy writes must fail closed',
  );
  await assert.rejects(
    f.act('setWorkflowCompositionPolicy', {
      organizationId: f.organization.id,
      baseRevision: 1,
      limits: { ...organizationLimits, maxConcurrentChildren: 4 },
    }),
    /below an existing project policy/i,
    'an organization ceiling cannot be reduced below a project override',
  );

  const workload = await f.act('createWorkloadIdentity', {
    organizationId: f.organization.id,
    displayName: 'Composition policy executor',
  });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'organization', organizationId: f.organization.id },
    roles: ['member'],
  });
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'project', projectId: f.projectB.id },
    roles: ['contributor'],
  });
  await f.act(
    'selectActiveContext',
    {
      context: { organizationId: f.organization.id, projectId: f.projectB.id },
    },
    principal,
  );
  await assert.rejects(
    f.act(
      'setWorkflowCompositionPolicy',
      {
        organizationId: f.organization.id,
        projectId: f.projectB.id,
        baseRevision: 0,
        limits: { ...organizationLimits, maxActiveDescendantRuns: 1 },
      },
      principal,
    ),
    /authorized|manage|available/i,
  );
  assert.equal(
    (await f.snapshot(principal)).workflowCompositionPolicies.projects[f.projectB.id],
    undefined,
    'a project contributor cannot change execution policy',
  );
});

test('map slots obey independent project and organization ceilings and advance from queued capacity', async (t) => {
  const barriers = new Map();
  const echo = echoRegistration(barriers);
  const f = await fixture(t, {
    workflowActivities: [{ descriptor: echo.descriptor, implementation: echo.implementation }],
    beforeClose: [
      async () => {
        for (const item of barriers.keys()) echo.release(item);
      },
    ],
  });
  const publish = (projectId, workflow) => f.act('saveWorkflow', { projectId, workflow });
  const childA = echoChildWorkflow(f.projectA.id);
  const childB = echoChildWorkflow(f.projectB.id);
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const publishedChildA = await publish(f.projectA.id, childA);
  const parentA = mapWorkflow(f.projectA.id, childA.id);
  const publishedParentA = await publish(f.projectA.id, parentA);
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectB.id },
  });
  const publishedChildB = await publish(f.projectB.id, childB);
  const parentB = mapWorkflow(f.projectB.id, childB.id);
  const publishedParentB = await publish(f.projectB.id, parentB);
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const missingMapIndex = {
    ...parentA,
    id: 'map-parent-missing-index',
    name: 'Map parent missing required index',
    nodes: parentA.nodes.map(({ indexField: _indexField, ...node }) => node),
  };
  await assert.rejects(
    publish(f.projectA.id, missingMapIndex),
    /required child field/i,
    'the injected item value does not satisfy a distinct required child index field',
  );

  const organizationLimits = { ...defaults, maxActiveDescendantRuns: 2 };
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: organizationLimits,
  });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    projectId: f.projectA.id,
    baseRevision: 0,
    limits: { ...organizationLimits, maxActiveDescendantRuns: 1 },
  });

  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const { workflowRunId: runA } = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedParentA.id,
    workflowVersion: publishedParentA.version,
    runInput: { items: ['inventory-1', 'inventory-2'] },
  });
  await waitFor(
    () => Promise.resolve([...echo.started]),
    (items) => items.includes('inventory-1'),
    'Project A did not dispatch its first map child',
  );
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectB.id },
  });
  const { workflowRunId: runB } = await f.act('startWorkflowRun', {
    projectId: f.projectB.id,
    workflowId: publishedParentB.id,
    workflowVersion: publishedParentB.version,
    runInput: { items: ['publication-1', 'publication-2'] },
  });
  await waitFor(
    () => Promise.resolve([...echo.started]),
    (items) => items.includes('publication-1'),
    'Project B should use its own project ceiling while the organization still has capacity',
  );
  assert.deepEqual([...echo.started].sort(), ['inventory-1', 'publication-1']);
  assert.deepEqual([...echo.active].sort(), ['inventory-1', 'publication-1']);
  assert.equal(
    echo.active.size,
    organizationLimits.maxActiveDescendantRuns,
    'a newly reserved slot consumes one active descendant reservation, not two',
  );

  const parentStateA = await f.readRun(runA);
  const parentStateB = await f.readRun(runB);
  const mapA = parentStateA.compositions.find((value) => value.nodeId === 'map-items');
  const mapB = parentStateB.compositions.find((value) => value.nodeId === 'map-items');
  assert.deepEqual(
    mapA.slots.map((value) => value.index),
    [0, 1],
  );
  assert.deepEqual(
    mapB.slots.map((value) => value.index),
    [0, 1],
  );
  assert.equal(
    new Set([...mapA.slots, ...mapB.slots].map((value) => value.runId)).size,
    4,
    'each reserved map slot keeps its canonical child run identity',
  );
  assert.equal(
    mapA.slots.filter((value) => value.status === 'queued').length,
    1,
    'Project A has one active descendant and one queued slot',
  );
  assert.equal(
    mapB.slots.filter((value) => value.status === 'queued').length,
    1,
    'the organization ceiling leaves one slot queued in Project B',
  );

  echo.release('inventory-1');
  await waitFor(
    () => Promise.resolve([...echo.started]),
    (items) => items.length === 3,
    'releasing one child reservation did not admit a queued slot',
  );
  assert.equal(
    echo.active.size,
    2,
    'queued work progresses without exceeding organization active capacity',
  );
  echo.completeAutomatically();
  for (const item of barriers.keys()) echo.release(item);
  const settled = await waitFor(
    async () => [await f.readRun(runA), await f.readRun(runB)],
    (runs) => runs.every((run) => ['completed', 'failed', 'cancelled'].includes(run.status)),
    'both independent maps did not settle their child outputs',
  );
  const diagnostic = (await f.readState()).workflowRuns;
  assert.deepEqual(
    settled.map((run) => run.status),
    ['completed', 'completed'],
    JSON.stringify(
      Object.values(diagnostic).map((run) => ({
        id: run.id,
        parentComposition: run.parentComposition,
        status: run.flow?.status,
        attempt: run.attempt && { status: run.attempt.status, message: run.attempt.message },
        compositionAttempts: run.compositionAttempts?.map((value) => ({
          nodeId: value.nodeId,
          status: value.status,
          message: value.message,
          slots: value.slots.map((slot) => ({
            runId: slot.runId,
            item: slot.input?.item,
            status: slot.status,
            message: slot.message,
          })),
        })),
      })),
    ),
  );
  assert.deepEqual([...echo.started].sort(), [
    'inventory-1',
    'inventory-2',
    'publication-1',
    'publication-2',
  ]);
  assert.equal(new Set(echo.started).size, 4, 'each exact child input is dispatched once');
  assert.equal(
    (await f.snapshot()).sessions.length,
    0,
    'no-agent child workflows do not allocate sessions',
  );
  assert.equal(publishedChildA.version, 1);
  assert.equal(publishedChildB.version, 1);
});

test('per-root active-descendant ceilings allow unrelated roots while limiting each root independently', async (t) => {
  const barriers = new Map();
  const echo = echoRegistration(barriers);
  const f = await fixture(t, {
    workflowActivities: [{ descriptor: echo.descriptor, implementation: echo.implementation }],
    beforeClose: [
      async () => {
        for (const item of barriers.keys()) echo.release(item);
      },
    ],
  });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const child = echoChildWorkflow(f.projectA.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parentA = mapWorkflow(f.projectA.id, child.id);
  parentA.nodes[0].maxConcurrent = 4;
  const parentB = { ...parentA, id: 'map-parent-root-b', name: 'Map parent root B' };
  const publishedA = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: parentA });
  const publishedB = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: parentB });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: {
      ...defaults,
      maxConcurrentChildren: 4,
      maxActiveDescendantRuns: 4,
      maxActiveDescendantsPerRoot: 1,
    },
  });
  const firstRoot = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedA.id,
    workflowVersion: publishedA.version,
    runInput: { items: ['root-a-1', 'root-a-2'] },
  });
  await waitFor(
    () => Promise.resolve([...echo.started]),
    (started) => started.includes('root-a-1'),
    'the first root did not admit its first descendant',
  );
  const secondRoot = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedB.id,
    workflowVersion: publishedB.version,
    runInput: { items: ['root-b-1', 'root-b-2'] },
  });
  await waitFor(
    () => Promise.resolve([...echo.started]),
    (started) => started.includes('root-b-1'),
    'one root at its per-root ceiling incorrectly starved another root',
  );
  assert.deepEqual([...echo.started].sort(), ['root-a-1', 'root-b-1']);
  assert.deepEqual([...echo.active].sort(), ['root-a-1', 'root-b-1']);
  const first = (await f.readRun(firstRoot.workflowRunId)).compositions[0];
  const second = (await f.readRun(secondRoot.workflowRunId)).compositions[0];
  assert.equal(first.slots.filter((slot) => slot.status === 'started').length, 1);
  assert.equal(first.slots.filter((slot) => slot.status === 'queued').length, 1);
  assert.equal(second.slots.filter((slot) => slot.status === 'started').length, 1);
  assert.equal(second.slots.filter((slot) => slot.status === 'queued').length, 1);

  echo.completeAutomatically();
  echo.release('root-a-1');
  echo.release('root-b-1');
  const settled = await waitFor(
    async () => [
      await f.readRun(firstRoot.workflowRunId),
      await f.readRun(secondRoot.workflowRunId),
    ],
    (runs) => runs.every((run) => run.status === 'completed'),
    'each root did not advance its own queued descendant after completion',
  );
  assert.deepEqual(
    settled.map((run) => run.status),
    ['completed', 'completed'],
  );
  assert.deepEqual([...echo.started].sort(), ['root-a-1', 'root-a-2', 'root-b-1', 'root-b-2']);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('nested coordinators consume descendant budget but do not deadlock per-root leaf capacity', async (t) => {
  for (const rootLimit of [1, 2]) {
    const receipts = new Map();
    const dispatches = [];
    const registration = durableMapRegistration(receipts, dispatches);
    const f = await fixture(t, { workflowActivities: [registration] });
    await f.act('selectActiveContext', {
      context: { organizationId: f.organization.id, projectId: f.projectA.id },
    });
    const leaf = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
    await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: leaf });
    const { inner, root } = nestedMapWorkflows(f.projectA.id, leaf.id, `cap-${rootLimit}`);
    await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: inner });
    const publishedRoot = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: root });
    await f.act('setWorkflowCompositionPolicy', {
      organizationId: f.organization.id,
      baseRevision: 0,
      limits: {
        ...defaults,
        maxActiveDescendantRuns: 4,
        maxActiveDescendantsPerRoot: rootLimit,
        maxConcurrentChildren: 4,
      },
    });
    const { workflowRunId } = await f.act('startWorkflowRun', {
      projectId: f.projectA.id,
      workflowId: publishedRoot.id,
      workflowVersion: publishedRoot.version,
    });
    await waitFor(
      async () => {
        const rootRun = await f.readRun(workflowRunId);
        const coordinatorId = rootRun.compositions.find((value) => value.nodeId === 'coordinate')
          ?.slots[0]?.runId;
        const coordinator = coordinatorId ? await f.readRun(coordinatorId) : undefined;
        return { dispatches: dispatches.length, root: rootRun, coordinator };
      },
      (value) => value.dispatches >= rootLimit,
      `root cap ${rootLimit} did not admit its available nested leaves`,
    );
    assert.equal(
      dispatches.length,
      rootLimit,
      `root cap ${rootLimit} must not overbook unknown nested leaves`,
    );
    const topRun = await f.readRun(workflowRunId);
    const outerComposition = topRun.compositions.find((value) => value.nodeId === 'coordinate');
    const coordinatorId = outerComposition.slots[0].runId;
    const coordinator = await f.readRun(coordinatorId);
    const nestedComposition = coordinator.compositions.find(
      (value) => value.nodeId === 'map-leaves',
    );
    assert.equal(outerComposition.slots[0].status, 'started');
    const reservedDescendantRuns = (await f.readState()).workflowRuns[workflowRunId]
      .compositionBudget.reservedDescendantRuns;
    assert.equal(
      reservedDescendantRuns,
      3,
      'the coordinator and both stable leaf slots consume the total descendant budget, including the queued leaf',
    );
    assert.equal(
      nestedComposition.slots.filter((slot) => slot.status === 'uncertain').length,
      rootLimit,
    );
    assert.equal(
      nestedComposition.slots.filter((slot) => slot.status === 'queued').length,
      2 - rootLimit,
    );
    assert.equal(
      dispatches.length,
      rootLimit,
      'a waiting composite coordinator must not double-count against active leaf capacity',
    );
    assert.equal(new Set(nestedComposition.slots.map((slot) => slot.runId)).size, 2);

    for (let index = 0; index < rootLimit; index += 1) {
      const slot = nestedComposition.slots[index];
      const childRun = await f.readRun(slot.runId);
      await f.act('claimWorkflowRun', { workflowRunId: childRun.id });
      await f.act('reconcileWorkflowRun', {
        workflowRunId: childRun.id,
        instance: childRun.instance,
        effectKey: childRun.attempt.effectKey,
        resolution: 'applied',
      });
      if (rootLimit === 1 && index === 0) {
        await waitFor(
          () => Promise.resolve(dispatches.length),
          (length) => length === 2,
          'a queued nested leaf did not proceed after unknown receipt reconciliation',
        );
        const refreshedCoordinator = await f.readRun(coordinatorId);
        const refreshedNested = refreshedCoordinator.compositions.find(
          (value) => value.nodeId === 'map-leaves',
        );
        assert.equal(refreshedNested.slots[0].status, 'completed');
        assert.equal(refreshedNested.slots[1].status, 'uncertain');
        const secondLeaf = await f.readRun(refreshedNested.slots[1].runId);
        await f.act('claimWorkflowRun', { workflowRunId: secondLeaf.id });
        await f.act('reconcileWorkflowRun', {
          workflowRunId: secondLeaf.id,
          instance: secondLeaf.instance,
          effectKey: secondLeaf.attempt.effectKey,
          resolution: 'applied',
        });
      }
    }
    if (rootLimit === 2) {
      assert.equal(dispatches.length, 2, 'active leaves cannot exceed the per-root ceiling');
    }
    const settled = await waitFor(
      () => f.readRun(workflowRunId),
      (run) => run.status === 'completed',
      `root cap ${rootLimit} did not complete after nested exact receipts settled`,
    );
    assert.equal(settled.status, 'completed');
    assert.equal(
      (await f.readState()).workflowRuns[workflowRunId].compositionBudget.reservedDescendantRuns,
      reservedDescendantRuns,
      'starting queued work and completing children must not reserve the same descendant slots twice',
    );
    assert.equal(dispatches.length, 2);
    assert.deepEqual(dispatches.map((entry) => entry.input.item).sort(), [
      `cap-${rootLimit}-leaf-1`,
      `cap-${rootLimit}-leaf-2`,
    ]);
    assert.equal(new Set(dispatches.map((entry) => entry.requestKey)).size, 2);
    assert.equal((await f.snapshot()).sessions.length, 0);
  }
});

test('a map-local concurrency ceiling holds queued work through restart until the exact unknown child receipt is reconciled', async (t) => {
  const receipts = new Map();
  const dispatches = [];
  const registration = durableMapRegistration(receipts, dispatches);
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const child = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  const publishedChild = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parent = mapWorkflow(f.projectA.id, child.id);
  parent.nodes[0].maxConcurrent = 1;
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: { ...defaults, maxActiveDescendantRuns: 3, maxConcurrentChildren: 3 },
  });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedParent.id,
    workflowVersion: publishedParent.version,
    runInput: { items: ['item-1', 'item-2'] },
  });
  await waitFor(
    () => Promise.resolve(dispatches.length),
    (value) => value === 1,
    'first map child did not dispatch',
  );
  const parentBeforeRestart = await f.readRun(workflowRunId);
  const slotsBeforeRestart = parentBeforeRestart.compositions.find(
    (value) => value.nodeId === 'map-items',
  ).slots;
  assert.equal(slotsBeforeRestart[0].status, 'uncertain');
  assert.equal(slotsBeforeRestart[1].status, 'queued');
  assert.equal(slotsBeforeRestart[0].instance.length > 0, true);
  assert.equal(typeof slotsBeforeRestart[0].effectKey, 'string');
  const firstChildId = slotsBeforeRestart[0].runId;
  const secondChildId = slotsBeforeRestart[1].runId;
  const firstChild = await f.readRun(firstChildId);
  const exactInstance = firstChild.instance;
  const exactEffectKey = firstChild.attempt.effectKey;
  const exactRequestKey = dispatches[0].requestKey;
  assert.equal(firstChild.attempt.status, 'uncertain');
  assert.equal(dispatches.length, 1);

  await f.restart();
  const recoveredParent = await f.readRun(workflowRunId);
  assert.equal(recoveredParent.status, 'interrupted');
  assert.equal(
    recoveredParent.attempt.status,
    'ready',
    'a parent composite has no external effect of its own and must recover as resumable rather than uncertain',
  );
  const recoveredSlots = recoveredParent.compositions.find(
    (value) => value.nodeId === 'map-items',
  ).slots;
  assert.deepEqual(
    recoveredSlots.map((slot) => [slot.runId, slot.status]),
    [
      [firstChildId, 'uncertain'],
      [secondChildId, 'queued'],
    ],
  );
  const recoveredChild = await f.readRun(firstChildId);
  assert.equal(recoveredChild.instance, exactInstance);
  assert.equal(recoveredChild.attempt.effectKey, exactEffectKey);
  assert.equal(dispatches[0].requestKey, exactRequestKey);
  assert.equal(dispatches.length, 1, 'restart must not repeat an uncertain child write');

  await f.act('claimWorkflowRun', { workflowRunId: firstChildId });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: firstChildId,
    instance: exactInstance,
    effectKey: exactEffectKey,
    resolution: 'applied',
  });
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('continueWorkflowRun', { workflowRunId, instance: recoveredParent.instance });
  await waitFor(
    async () => ({
      dispatches: dispatches.length,
      parent: await f.readRun(workflowRunId),
      child: await f.readRun(firstChildId),
    }),
    (value) => value.dispatches === 2,
    'the queued child was not admitted after exact receipt reconciliation released capacity',
  );
  assert.equal(dispatches.filter((value) => value.requestKey === exactRequestKey).length, 1);
  const afterAdmission = await f.readRun(workflowRunId);
  const admittedSlots = afterAdmission.compositions.find(
    (value) => value.nodeId === 'map-items',
  ).slots;
  assert.equal(admittedSlots[0].runId, firstChildId);
  assert.equal(admittedSlots[0].status, 'completed');
  assert.equal(admittedSlots[1].runId, secondChildId);
  assert.equal(admittedSlots[1].status, 'uncertain');

  const secondChild = await f.readRun(secondChildId);
  await f.act('claimWorkflowRun', { workflowRunId: secondChildId });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: secondChildId,
    instance: secondChild.instance,
    effectKey: secondChild.attempt.effectKey,
    resolution: 'applied',
  });
  const completed = await waitFor(
    () => f.readRun(workflowRunId),
    (value) => value.status === 'completed',
    'map parent did not complete after both exact child receipts were reconciled',
  );
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    dispatches.map((value) => value.input.item),
    ['item-1', 'item-2'],
  );
  assert.equal(new Set(dispatches.map((value) => value.requestKey)).size, 2);
  assert.equal(publishedChild.version, 1);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('reducing active-descendant policy below current unknown usage holds admission but preserves exact reconciliation', async (t) => {
  const receipts = new Map();
  const dispatches = [];
  const registration = durableMapRegistration(receipts, dispatches);
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const child = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parent = mapWorkflow(f.projectA.id, child.id);
  parent.nodes[0].maxConcurrent = 3;
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  const initialLimits = { ...defaults, maxConcurrentChildren: 3, maxActiveDescendantRuns: 2 };
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: initialLimits,
  });
  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedParent.id,
    workflowVersion: publishedParent.version,
    runInput: { items: ['uncertain-1', 'uncertain-2', 'queued-3'] },
  });
  await waitFor(
    () => Promise.resolve(dispatches.length),
    (value) => value === 2,
    'two descendants did not consume the initial active ceiling',
  );
  const parentAtCeiling = await f.readRun(workflowRunId);
  let slots = parentAtCeiling.compositions.find((value) => value.nodeId === 'map-items').slots;
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['uncertain', 'uncertain', 'queued'],
  );
  const exact = slots
    .slice(0, 2)
    .map((slot) => ({ runId: slot.runId, instance: slot.instance, effectKey: slot.effectKey }));
  const queuedRunId = slots[2].runId;
  assert.equal(new Set(exact.map((value) => value.runId)).size, 2);

  const lowerLimits = { ...initialLimits, maxActiveDescendantRuns: 1 };
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 1,
    limits: lowerLimits,
  });
  const afterReduction = await f.readRun(workflowRunId);
  slots = afterReduction.compositions.find((value) => value.nodeId === 'map-items').slots;
  assert.deepEqual(
    slots.map((slot) => [slot.runId, slot.status]),
    [
      [exact[0].runId, 'uncertain'],
      [exact[1].runId, 'uncertain'],
      [queuedRunId, 'queued'],
    ],
  );
  assert.equal(
    dispatches.length,
    2,
    'a lower current ceiling cannot admit new work while two unknown effects remain',
  );

  for (const [index, childIdentity] of exact.entries()) {
    await f.act('claimWorkflowRun', { workflowRunId: childIdentity.runId });
    await f.act('reconcileWorkflowRun', {
      workflowRunId: childIdentity.runId,
      instance: childIdentity.instance,
      effectKey: childIdentity.effectKey,
      resolution: 'applied',
    });
    if (index === 0) {
      assert.equal(
        dispatches.length,
        2,
        'the remaining uncertain child still consumes the reduced active ceiling',
      );
    }
  }
  await waitFor(
    () => Promise.resolve(dispatches.length),
    (value) => value === 3,
    'queued descendant was not admitted after both exact receipts released active capacity',
  );
  const afterAdmission = await f.readRun(workflowRunId);
  slots = afterAdmission.compositions.find((value) => value.nodeId === 'map-items').slots;
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['completed', 'completed', 'uncertain'],
  );
  const finalChild = await f.readRun(slots[2].runId);
  await f.act('claimWorkflowRun', { workflowRunId: finalChild.id });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: finalChild.id,
    instance: finalChild.instance,
    effectKey: finalChild.attempt.effectKey,
    resolution: 'applied',
  });
  const completed = await waitFor(
    () => f.readRun(workflowRunId),
    (value) => value.status === 'completed',
    'the parent did not complete after each exact receipt settled',
  );
  const completedState = (await f.readState()).workflowRuns[workflowRunId];
  assert.equal(
    completed.status,
    'completed',
    JSON.stringify({
      flow: completedState.flow,
      attempt: completedState.attempt,
      compositions: completedState.compositionAttempts,
    }),
  );
  assert.deepEqual(
    dispatches.map((value) => value.input.item),
    ['uncertain-1', 'uncertain-2', 'queued-3'],
  );
  assert.equal(new Set(dispatches.map((value) => value.requestKey)).size, 3);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('cancelling a composed parent cancels queued children and keeps an applied child unknown until its exact receipt is reconciled', async (t) => {
  const receipts = new Map();
  const dispatches = [];
  const registration = durableMapRegistration(receipts, dispatches);
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const child = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parent = mapWorkflow(f.projectA.id, child.id);
  parent.nodes[0].maxConcurrent = 1;
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: { ...defaults, maxActiveDescendantRuns: 2 },
  });
  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedParent.id,
    workflowVersion: publishedParent.version,
    runInput: { items: ['cancel-me', 'must-not-start'] },
  });
  await waitFor(
    () => Promise.resolve(dispatches.length),
    (value) => value === 1,
    'first child did not reach its durable write',
  );
  const parentBeforeCancel = await f.readRun(workflowRunId);
  const slots = parentBeforeCancel.compositions.find((value) => value.nodeId === 'map-items').slots;
  const [uncertainSlot, queuedSlot] = slots;
  assert.equal(uncertainSlot.status, 'uncertain');
  assert.equal(queuedSlot.status, 'queued');
  const childBeforeCancel = await f.readRun(uncertainSlot.runId);
  await f.act('claimWorkflowRun', { workflowRunId });
  await f.act('cancelWorkflowRun', { workflowRunId });
  const cancelledParent = await f.readRun(workflowRunId);
  assert.equal(cancelledParent.status, 'cancelled');
  const cancelledSlots = cancelledParent.compositions.find(
    (value) => value.nodeId === 'map-items',
  ).slots;
  assert.equal(cancelledSlots[0].runId, uncertainSlot.runId);
  assert.equal(cancelledSlots[0].status, 'uncertain');
  assert.equal(cancelledSlots[1].runId, queuedSlot.runId);
  assert.equal(cancelledSlots[1].status, 'cancelled');
  const cancelledChild = await f.readRun(uncertainSlot.runId);
  assert.equal(cancelledChild.status, 'cancelled');
  assert.equal(cancelledChild.attempt.status, 'uncertain');
  assert.equal(cancelledChild.instance, childBeforeCancel.instance);
  assert.equal(cancelledChild.attempt.effectKey, childBeforeCancel.attempt.effectKey);
  assert.equal(dispatches.length, 1);

  await f.act('claimWorkflowRun', { workflowRunId: uncertainSlot.runId });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: uncertainSlot.runId,
    instance: childBeforeCancel.instance,
    effectKey: childBeforeCancel.attempt.effectKey,
    resolution: 'applied',
  });
  const afterReconcile = await f.readRun(workflowRunId);
  assert.equal(
    afterReconcile.status,
    'cancelled',
    'reconciliation cannot revive a cancelled graph',
  );
  assert.equal(
    afterReconcile.compositions.find((value) => value.nodeId === 'map-items').slots[1].status,
    'cancelled',
  );
  assert.deepEqual(
    dispatches.map((value) => value.input.item),
    ['cancel-me'],
  );
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('first-success pins one winner but waits for a dispatched loser receipt before advancing its successor', async (t) => {
  const loserEntered = deferred();
  const releaseLoser = deferred();
  const receipts = new Map();
  const dispatches = [];
  const durable = durableMapRegistration(receipts, dispatches);
  const followCalls = [];
  const winnerSchema = {
    type: 'object',
    properties: { winner: { type: 'string', maxLength: 80 } },
    required: ['winner'],
    additionalProperties: false,
  };
  const follow = {
    descriptor: {
      ref: { id: 'composition.follow-winner', revision: 1 },
      inputSchema: winnerSchema,
      outputSchema: winnerSchema,
      resources: { location: 'integration', adapterId: 'composition-acceptance' },
      effect: 'pure',
      approval: { required: false },
      cancellation: 'immediate',
      confirmation: 'result',
      reconciliation: 'none',
      presentation: { label: 'Use winning result' },
    },
    implementation: {
      async prepare(input) {
        return structuredClone(input);
      },
      async dispatch(_context, input) {
        followCalls.push(structuredClone(input));
        return { state: 'completed', output: structuredClone(input) };
      },
    },
  };
  durable.implementation.dispatch = async (_context, input, intent) => {
    dispatches.push({ requestKey: intent.requestKey, input: structuredClone(input) });
    if (input.item === 'slow') {
      receipts.set(intent.requestKey, structuredClone(input));
      loserEntered.resolve();
      await releaseLoser.promise;
      throw new Error('The slower applied branch lost its acknowledgement.');
    }
    await loserEntered.promise;
    return { state: 'completed', output: structuredClone(input) };
  };
  const f = await fixture(t, {
    workflowActivities: [durable, follow],
    beforeClose: [async () => releaseLoser.resolve()],
  });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const child = durableMapChildWorkflow(f.projectA.id, durable.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parent = firstSuccessWorkflow(f.projectA.id, child.id, follow.descriptor.ref.id);
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id,
    baseRevision: 0,
    limits: { ...defaults, maxConcurrentChildren: 2, maxActiveDescendantRuns: 2 },
  });
  const { workflowRunId } = await f.act('startWorkflowRun', {
    projectId: f.projectA.id,
    workflowId: publishedParent.id,
    workflowVersion: publishedParent.version,
  });
  await waitFor(
    () => Promise.resolve(dispatches.some((value) => value.input.item === 'slow')),
    Boolean,
    'the loser did not begin its durable effect',
  );
  const winnerState = await waitFor(
    () => f.readRun(workflowRunId),
    (run) => {
      const composition = run.compositions.find((value) => value.nodeId === 'race');
      return composition?.winnerSlotId ? run : false;
    },
    'the successful branch was not durably selected',
  );
  const composition = winnerState.compositions.find((value) => value.nodeId === 'race');
  const winner = composition.slots.find((slot) => slot.slotId === composition.winnerSlotId);
  const loser = composition.slots.find((slot) => slot.slotId !== composition.winnerSlotId);
  assert.equal(winner.status, 'completed');
  assert.equal(loser.status, 'uncertain');
  assert.equal(loser.effectKey.length > 0, true);
  assert.equal(
    followCalls.length,
    0,
    'the parent cannot advance while an already-dispatched loser is unresolved',
  );
  assert.notEqual(winner.runId, loser.runId);
  const loserRun = await f.readRun(loser.runId);
  const loserInstance = loserRun.instance;
  const loserEffectKey = loserRun.attempt.effectKey;
  assert.equal(loserRun.attempt.status, 'uncertain');
  assert.equal(dispatches.length, 2);

  releaseLoser.resolve();
  await waitFor(
    () => f.readRun(loser.runId),
    (run) => run.attempt.status === 'uncertain',
    'the cancelled loser did not retain its unknown durable attempt',
  );
  await f.act('claimWorkflowRun', { workflowRunId: loser.runId });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: loser.runId,
    instance: loserInstance,
    effectKey: loserEffectKey,
    resolution: 'applied',
  });
  const completed = await waitFor(
    () => f.readRun(workflowRunId),
    (run) => ['completed', 'failed', 'cancelled'].includes(run.status),
    'first-success parent did not advance after exact loser reconciliation',
  );
  const completedState = (await f.readState()).workflowRuns[workflowRunId];
  assert.equal(
    completed.status,
    'completed',
    JSON.stringify({
      flow: completedState.flow,
      attempt: completedState.attempt,
      compositions: completedState.compositionAttempts,
    }),
  );
  assert.equal(
    completed.compositions.find((value) => value.nodeId === 'race').winnerSlotId,
    winner.slotId,
  );
  assert.deepEqual(followCalls, [{ winner: 'fast' }]);
  assert.equal(
    dispatches.filter((value) => value.input.item === 'slow').length,
    1,
    'reconciling a cancelled loser cannot repeat its effect',
  );
  assert.equal(dispatches.filter((value) => value.input.item === 'fast').length, 1);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('a parent cannot create a child run for a workflow owned by another organization', async (t) => {
  const f = await fixture(t);
  const otherOrganization = await f.act('createOrganization', {
    slug: `composition-foreign-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Unrelated tenant',
    kind: 'team',
  });
  const foreignProject = await f.act('saveProject', {
    organizationId: otherOrganization.id,
    name: 'Foreign inventory',
  });
  await f.act('selectActiveContext', {
    context: { organizationId: otherOrganization.id, projectId: foreignProject.id },
  });
  const foreignChild = await f.act('saveWorkflow', {
    projectId: foreignProject.id,
    workflow: {
      id: 'foreign-child',
      name: 'Foreign child',
      nodes: [
        {
          id: 'review',
          kind: 'human',
          name: 'Review foreign work',
          prompt: 'Review this tenant-owned work.',
        },
      ],
      edges: [],
    },
  });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const parent = {
    id: 'cross-tenant-parent',
    name: 'Cross-tenant parent',
    projectId: f.projectA.id,
    nodes: [
      {
        id: 'foreign-child-call',
        kind: 'child',
        name: 'Call foreign workflow',
        workflow: { id: foreignChild.id, version: foreignChild.version },
        inputBindings: {},
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputBindings: {},
      },
    ],
    edges: [],
  };
  const before = await f.readState();
  let published;
  try {
    published = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: parent });
  } catch (error) {
    assert.match(String(error), /organization|project|scope|available|authorized|same/i);
    assert.deepEqual(
      Object.keys((await f.readState()).workflowRuns ?? {}),
      Object.keys(before.workflowRuns ?? {}),
    );
    return;
  }
  await assert.rejects(
    f.act('startWorkflowRun', {
      projectId: f.projectA.id,
      workflowId: published.id,
      workflowVersion: published.version,
    }),
    /organization|project|scope|available|authorized|same/i,
    'a valid caller for the parent project still cannot invoke a foreign-owned child',
  );
  const after = await f.readState();
  assert.equal(
    Object.values(after.workflowRuns ?? {}).some((run) => run.parentComposition?.parentRunId),
    false,
    'foreign child rejection must happen before any child run is created',
  );
  assert.equal(
    Object.values(after.workflowRuns ?? {}).some(
      (run) => run.workflowId === foreignChild.id && run.id !== published.id,
    ),
    false,
  );
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('revoking the stored root principal before the approval gate prevents every descendant from starting', async (t) => {
  const dispatches = [];
  const receipts = new Map();
  const registration = durableMapRegistration(receipts, dispatches);
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const workload = await f.act('createWorkloadIdentity', {
    organizationId: f.organization.id,
    displayName: 'Composition child executor',
  });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'organization', organizationId: f.organization.id },
    roles: ['member'],
  });
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'project', projectId: f.projectA.id },
    roles: ['contributor'],
  });
  const child = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const map = mapWorkflow(f.projectA.id, child.id);
  const parent = {
    ...map,
    id: 'revoked-composition-parent',
    name: 'Revoked composition parent',
    nodes: [
      {
        id: 'review',
        name: 'Review composition',
        kind: 'human',
        prompt: 'Authorize descendant work.',
      },
      ...map.nodes,
    ],
    edges: [{ from: 'review', to: 'map-items', outcome: 'approved' }],
  };
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  await f.act(
    'selectActiveContext',
    { context: { organizationId: f.organization.id, projectId: f.projectA.id } },
    principal,
  );
  const { workflowRunId } = await f.act(
    'startWorkflowRun',
    {
      projectId: f.projectA.id,
      workflowId: publishedParent.id,
      workflowVersion: publishedParent.version,
      runInput: { items: ['must-remain-held'] },
    },
    principal,
  );
  const waiting = await f.readRun(workflowRunId);
  assert.equal(waiting.status, 'waiting_gate');
  assert.equal(waiting.compositions?.length ?? 0, 0);
  await f.act('revokeWorkloadIdentity', {
    organizationId: f.organization.id,
    workloadIdentityId: workload.id,
    expectedRevision: workload.revision,
  });
  await assert.rejects(
    f.act(
      'decideWorkflowRun',
      {
        workflowRunId,
        instance: waiting.instance,
        decision: 'approve',
      },
      principal,
    ),
    /revoked|not active|authorized|available/i,
  );
  const persisted = await f.readState();
  assert.deepEqual(
    Object.values(persisted.workflowRuns ?? {}).filter((run) => run.parentComposition),
    [],
  );
  assert.equal(dispatches.length, 0);
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('revoking the root principal after a descendant write prevents the revoked actor from reconciling or starting queued work', async (t) => {
  const receipts = new Map();
  const dispatches = [];
  const registration = durableMapRegistration(receipts, dispatches);
  const f = await fixture(t, { workflowActivities: [registration] });
  await f.act('selectActiveContext', {
    context: { organizationId: f.organization.id, projectId: f.projectA.id },
  });
  const workload = await f.act('createWorkloadIdentity', {
    organizationId: f.organization.id,
    displayName: 'Composition effect executor',
  });
  const principal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'organization', organizationId: f.organization.id },
    roles: ['member'],
  });
  await f.act('createMembership', {
    organizationId: f.organization.id,
    principal,
    scope: { kind: 'project', projectId: f.projectA.id },
    roles: ['contributor'],
  });
  const child = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: child });
  const parent = mapWorkflow(f.projectA.id, child.id);
  parent.nodes[0].maxConcurrent = 1;
  const publishedParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id,
    workflow: parent,
  });
  await f.act(
    'selectActiveContext',
    { context: { organizationId: f.organization.id, projectId: f.projectA.id } },
    principal,
  );
  const { workflowRunId } = await f.act(
    'startWorkflowRun',
    {
      projectId: f.projectA.id,
      workflowId: publishedParent.id,
      workflowVersion: publishedParent.version,
      runInput: { items: ['already-uncertain', 'must-stay-queued'] },
    },
    principal,
  );
  await waitFor(
    () => Promise.resolve(dispatches.length),
    (length) => length === 1,
    'the first descendant did not reach the external effect boundary',
  );
  const beforeRevocation = await f.readRun(workflowRunId);
  const slots = beforeRevocation.compositions.find((value) => value.nodeId === 'map-items').slots;
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['uncertain', 'queued'],
  );
  const childBeforeRevocation = await f.readRun(slots[0].runId);

  await f.act('revokeWorkloadIdentity', {
    organizationId: f.organization.id,
    workloadIdentityId: workload.id,
    expectedRevision: workload.revision,
  });
  await assert.rejects(
    f.act('claimWorkflowRun', { workflowRunId: slots[0].runId }, principal),
    /revoked|not active|authorized/i,
  );
  await assert.rejects(
    f.act(
      'reconcileWorkflowRun',
      {
        workflowRunId: slots[0].runId,
        instance: childBeforeRevocation.instance,
        effectKey: childBeforeRevocation.attempt.effectKey,
        resolution: 'applied',
      },
      principal,
    ),
    /revoked|not active|authorized/i,
  );
  await f.act('claimWorkflowRun', { workflowRunId });
  await assert.rejects(
    f.act('continueWorkflowRun', { workflowRunId, instance: beforeRevocation.instance }),
    /revoked|not active|authorized/i,
    'a different controller cannot advance a composition owned by the revoked execution principal',
  );
  const afterRevocation = await f.readRun(workflowRunId);
  assert.equal(afterRevocation.compositions[0].slots[0].runId, slots[0].runId);
  assert.equal(afterRevocation.compositions[0].slots[1].runId, slots[1].runId);
  assert.equal(
    dispatches.length,
    1,
    'the revoked identity cannot dispatch queued work or replay its effect',
  );
  assert.equal((await f.snapshot()).sessions.length, 0);
});

test('a human-approved agent child waits above current active capacity, then runs once after exact cleanup', async (t) => {
  const receipts = new Map();
  const dispatches = [];
  const registration = durableMapRegistration(receipts, dispatches);
  let providerCalls = 0;
  const f = await fixture(t, {
    workflowActivities: [registration],
    runtimeOptions: {
      provider: { id: 'composition-legacy', name: 'Composition legacy provider', capabilities: [] },
      credentialBroker: { resolve: async () => ({ value: 'fixture-credential' }) },
      providerAdapters: createProviderAdapterRegistry({ 'composition-mock': () => ({
        protocol: 'openai-compatible', capabilities: ['streaming', 'tool-calls'],
        inspectConnection: async () => ({ available: true }),
        discoverModels: async () => [{ id: 'capacity-model', name: 'Capacity fixture model', input: ['text'] }],
        async *generate() {
          providerCalls += 1;
          yield {
            type: 'result',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: `submit-${providerCalls}`, name: 'submit_step', arguments: {
                summary: 'Reviewed after capacity became available',
                details: { summary: 'Reviewed after capacity became available' },
                outcome: 'success', artifacts: [], references: [],
              } }],
              stopReason: 'stop', timestamp: Date.now(),
            },
          };
        },
      }) }),
      deployment: { id: 'composition-policy-test', displayName: 'Composition policy test',
        issuer: 'https://composition.test', publicOrigin: 'https://composition.test',
        capabilities: ['organizations', 'provider-connections'], authenticationMethods: ['local-bootstrap'] },
    },
  });
  const connection = await f.act('createProviderConnection', {
    organizationId: f.organization.id, providerId: 'composition-mock',
    displayName: 'Composition mock', owner: { kind: 'organization', organizationId: f.organization.id },
    credentialRef: { kind: 'none' },
  });
  const probe = await f.act('probeProviderConnection', {
    organizationId: f.organization.id, connectionId: connection.id, expectedRevision: connection.revision,
  });
  const route = await f.act('createModelRoute', {
    organizationId: f.organization.id, name: 'composition-capacity-route', purposes: ['coding'],
    candidates: [{ connectionId: connection.id, offeringId: probe.offerings[0].id }],
    policy: { fallback: 'never' },
  });

  const unknownChild = durableMapChildWorkflow(f.projectA.id, registration.descriptor.ref.id);
  await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: unknownChild });
  const unknownParent = mapWorkflow(f.projectA.id, unknownChild.id);
  unknownParent.nodes[0].maxConcurrent = 1;
  const publishedUnknownParent = await f.act('saveWorkflow', {
    projectId: f.projectA.id, workflow: unknownParent,
  });

  const agentResultSchema = {
    type: 'object', properties: { summary: { type: 'string', maxLength: 4000 } },
    required: ['summary'], additionalProperties: false,
  };
  const gatedAgent = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: {
    id: 'capacity-gated-agent-child', name: 'Capacity gated agent child', projectId: f.projectA.id,
    runInputSchema: { type: 'object', properties: { recordId: { type: 'string', maxLength: 80 } },
      required: ['recordId'], additionalProperties: false },
    resultSchema: agentResultSchema,
    resultBindings: { summary: { from: { kind: 'agent_submission', nodeId: 'assess', path: ['summary'] } } },
    nodes: [
      { id: 'review', kind: 'human', name: 'Authorize assessment', humanTask: {
        outcomes: [
          { id: 'approve_assessment', label: 'Approve assessment' },
          { id: 'decline_assessment', label: 'Decline assessment' },
        ],
        form: { fields: [{ id: 'reason', label: 'Review note', type: 'text', required: true, minLength: 3, maxLength: 120 }] },
      } },
      { id: 'assess', kind: 'agent', model: route.id, permissions: 'none', name: 'Assess record',
        prompt: 'Assess the record and submit a concise summary.', maxRounds: 2,
        submissionRequirements: { success: { fields: ['summary'], minReferences: 0 } } },
    ],
    edges: [{ from: 'review', to: 'assess', outcome: 'approve_assessment' }],
  } });
  const agentParent = await f.act('saveWorkflow', { projectId: f.projectA.id, workflow: {
    id: 'capacity-gated-agent-parent', name: 'Capacity gated agent parent', projectId: f.projectA.id,
    runInputSchema: { type: 'object', properties: { recordId: { type: 'string', maxLength: 80 } },
      required: ['recordId'], additionalProperties: false },
    nodes: [{ id: 'assess-child', kind: 'child', name: 'Run reviewed assessment',
      workflow: { id: gatedAgent.id, version: gatedAgent.version },
      inputBindings: { recordId: { from: { kind: 'run_input', path: ['recordId'] } } },
      outputSchema: agentResultSchema, outputBindings: { summary: { from: ['summary'] } } }],
    edges: [],
  } });

  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id, baseRevision: 0,
    limits: { ...defaults, maxActiveDescendantRuns: 2 },
  });
  const unknownRoot = await f.act('startWorkflowRun', {
    projectId: f.projectA.id, workflowId: publishedUnknownParent.id,
    workflowVersion: publishedUnknownParent.version, runInput: { items: ['held-effect'] },
  });
  await waitFor(() => Promise.resolve(dispatches.length), count => count === 1,
    'the unrelated durable child did not retain its unknown effect');
  const unknownComposition = await f.readRun(unknownRoot.workflowRunId);
  const unknownSlot = unknownComposition.compositions[0].slots[0];
  const unknownRun = await f.readRun(unknownSlot.runId);
  assert.equal(unknownRun.attempt.status, 'uncertain');

  const agentRoot = await f.act('startWorkflowRun', {
    projectId: f.projectA.id, workflowId: agentParent.id, workflowVersion: agentParent.version,
    runInput: { recordId: 'record-29' },
  });
  const agentParentRun = await waitFor(() => f.readRun(agentRoot.workflowRunId),
    run => run.compositions?.[0]?.slots?.[0]?.runId,
    'the human-gated agent child was not reserved');
  const agentSlot = agentParentRun.compositions[0].slots[0];
  const agentRunId = agentSlot.runId;
  let agentRun = await waitFor(() => f.readRun(agentRunId),
    run => run.status === 'waiting_gate', 'the agent child did not reach its configured human gate');
  assert.equal(providerCalls, 0);
  assert.equal((await f.snapshot()).sessions.length, 0, 'the gate must not allocate an agent session');

  await f.act('setWorkflowCompositionPolicy', {
    organizationId: f.organization.id, baseRevision: 1,
    limits: { ...defaults, maxActiveDescendantRuns: 1 },
  });
  await f.act('claimWorkflowRun', { workflowRunId: agentRunId });
  const response = await f.act('submitWorkflowHumanResponse', {
    workflowRunId: agentRunId, instance: agentRun.instance,
    values: { reason: 'Capacity checked before dispatch.' },
  });
  const review = await f.act('prepareWorkflowHumanReview', {
    workflowRunId: agentRunId, instance: agentRun.instance,
    responseId: response.id, outcomeId: 'approve_assessment', targetNodeId: 'assess',
  });
  await f.act('decideWorkflowRun', {
    workflowRunId: agentRunId, instance: agentRun.instance,
    outcomeId: 'approve_assessment', responseId: response.id, reviewedMaterialDigest: review.materialDigest,
  });
  agentRun = await waitFor(() => f.readRun(agentRunId),
    run => ['paused', 'failed', 'completed'].includes(run.status) || providerCalls > 0,
    'the approved agent child did not reach a dispatch decision under the reduced active ceiling');
  assert.equal(agentRun.status, 'paused', JSON.stringify(agentRun));
  const heldState = await f.readState();
  assert.match(heldState.workflowRuns[agentRunId].queueReason ?? '', /capacity|descendant|composition/i);
  assert.equal(agentRun.attempt.status, 'ready', 'the approved activity remains safely before provider dispatch');
  const blockedInstance = agentRun.instance;
  assert.equal(agentRun.workflowVersion, gatedAgent.version);
  assert.equal(providerCalls, 0, 'capacity denial occurs before provider generation');
  assert.equal((await f.snapshot()).sessions.length, 0, 'capacity denial occurs before lazy agent-session creation');
  assert.equal(dispatches.length, 1, 'no new registered mutation starts while current usage is above policy');

  await f.restart();
  const recoveredAgent = await f.readRun(agentRunId);
  assert.equal(recoveredAgent.status, 'paused');
  assert.equal(recoveredAgent.instance, blockedInstance);
  assert.equal(recoveredAgent.workflowVersion, gatedAgent.version);
  assert.equal(providerCalls, 0);
  const recoveredAgentParent = await f.readRun(agentRoot.workflowRunId);
  assert.equal(recoveredAgentParent.status, 'interrupted');
  await f.act('claimWorkflowRun', { workflowRunId: agentRoot.workflowRunId });
  await f.act('continueWorkflowRun', {
    workflowRunId: agentRoot.workflowRunId, instance: recoveredAgentParent.instance,
  });

  const recoveredUnknown = await f.readRun(unknownSlot.runId);
  await f.act('claimWorkflowRun', { workflowRunId: unknownSlot.runId });
  await f.act('reconcileWorkflowRun', {
    workflowRunId: unknownSlot.runId, instance: recoveredUnknown.instance,
    effectKey: recoveredUnknown.attempt.effectKey, resolution: 'applied',
  });
  const recoveredUnknownParent = await f.readRun(unknownRoot.workflowRunId);
  await f.act('claimWorkflowRun', { workflowRunId: unknownRoot.workflowRunId });
  await f.act('continueWorkflowRun', {
    workflowRunId: unknownRoot.workflowRunId, instance: recoveredUnknownParent.instance,
  });
  await f.act('claimWorkflowRun', { workflowRunId: agentRunId });
  await f.act('continueWorkflowRun', { workflowRunId: agentRunId, instance: blockedInstance });
  agentRun = await waitFor(() => f.readRun(agentRunId),
    run => run.status === 'completed' || run.status === 'failed',
    'the exact human-approved child did not resume when active capacity became available');
  const finalState = await f.readState();
  assert.equal(agentRun.status, 'completed', JSON.stringify({
    run: agentRun, providerCalls, owner: finalState.workflowRuns[agentRunId],
    unknownParent: finalState.workflowRuns[unknownRoot.workflowRunId],
    unknownChild: finalState.workflowRuns[unknownSlot.runId],
    session: agentRun.sessionId ? finalState.sessions?.[agentRun.sessionId] : null,
  }));
  assert.equal(agentRun.workflowVersion, gatedAgent.version);
  assert.equal(providerCalls, 1, 'the accepted mock-provider submission runs exactly once');
  assert.equal(dispatches.length, 1, 'the unrelated unknown effect is reconciled, never replayed');
  assert.equal(finalState.workflowRuns[agentRunId].flow.instance, blockedInstance);
  assert.equal(agentRun.history.filter(entry => entry.nodeId === 'assess').length, 1,
    'the child retains one accepted submit_step receipt in canonical workflow history');
  assert.equal(agentRun.history.find(entry => entry.nodeId === 'assess')?.summary,
    'Reviewed after capacity became available');
  assert.equal((await f.readRun(agentRoot.workflowRunId)).status, 'completed');
});
