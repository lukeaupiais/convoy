import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityCatalog } from '../../apps/daemon/src/modules/workflows/activity-catalog.mjs';
import {
  activityDigest,
  resolveActivityBindings,
  schemaAssignable,
  validateActivityBindings,
  validateWorkflowResultBindings,
  validateActivitySchema,
  validateActivityValue,
} from '../../apps/daemon/src/modules/workflows/activity-data.mjs';
import { normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { createWorkflows } from '../../apps/daemon/src/modules/workflows/workflow-module.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/default-workflow.mjs';

const number = { type: 'number', minimum: 0, maximum: 1000 };
const bool = { type: 'boolean' };
const list = { type: 'array', items: { type: 'string', maxLength: 20 }, minItems: 1, maxItems: 8 };

test('bounded activity schemas validate typed values and reject unsupported or mismatched keywords', () => {
  const schema = { type: 'object', properties: { amount: number, ready: bool, labels: list }, required: ['amount'], additionalProperties: false };
  assert.deepEqual(validateActivityValue({ amount: 4, ready: true, labels: ['alpha'] }, schema), { amount: 4, ready: true, labels: ['alpha'] });
  assert.throws(() => validateActivityValue({ amount: '4' }, schema), /expected number/);
  assert.throws(() => validateActivityValue({ amount: 4, extra: true }, schema), /not declared/);
  assert.throws(() => validateActivitySchema({ type: 'object', properties: {}, items: bool }), /keywords do not match object/);
  assert.throws(() => validateActivitySchema({ type: 'string', pattern: '.*' }), /unsupported.*pattern/);
  assert.throws(() => validateActivityValue(JSON.parse('{"__proto__":true}'), { type: 'object', properties: {}, additionalProperties: true }), /unsafe key/);
});

test('object enum equality is canonical and bounded JSON limits count UTF-8 bytes', () => {
  const schema = { type: 'object', enum: [{ alpha: 1, beta: 2 }], properties: {}, additionalProperties: true };
  assert.deepEqual(validateActivityValue({ beta: 2, alpha: 1 }, schema), { beta: 2, alpha: 1 });
  assert.equal(schemaAssignable({ type: 'object', enum: [{ beta: 2, alpha: 1 }], properties: {}, additionalProperties: true },
    { type: 'object', enum: [{ alpha: 1, beta: 2 }], properties: {}, additionalProperties: true }), true);
  assert.throws(() => validateActivityValue('é'.repeat(33_000), { type: 'string' }), /too large/);
});

test('activity bindings allow reachable prior outputs and reject forward, unsafe and missing values', () => {
  const catalog = createActivityCatalog();
  const workflow = normalizeWorkflow({
    id: 'bound-transform', name: 'Bound transform', runInputSchema: {
      type: 'object', properties: { amount: number, enabled: bool, labels: list }, required: ['amount', 'enabled', 'labels'], additionalProperties: false,
    },
    nodes: [
      { id: 'multiply', name: 'Multiply', kind: 'action', activity: { id: 'data.multiply', revision: 1 }, bindings: {
        amount: { from: { kind: 'run_input', path: ['amount'] } }, factor: { literal: 3 },
      } },
      { id: 'later', name: 'Later', kind: 'action', activity: { id: 'data.multiply', revision: 1 }, bindings: {
        amount: { from: { kind: 'activity_output', nodeId: 'multiply', path: ['amount'] } }, factor: { literal: 2 },
      } },
    ], edges: [{ from: 'multiply', to: 'later', outcome: 'success' }],
  }, { publishing: true });
  validateActivityBindings(workflow.nodes[0], workflow, catalog);
  validateActivityBindings(workflow.nodes[1], workflow, catalog);
  const reverseBinding = { ...workflow.nodes[0], bindings: { amount: { from: { kind: 'activity_output', nodeId: 'later', path: ['amount'] } }, factor: { literal: 2 } } };
  assert.throws(() => validateActivityBindings(reverseBinding, workflow, catalog), /prior registered activity/);
  assert.throws(() => validateActivityBindings({ ...workflow.nodes[1], bindings: { amount: { from: { kind: 'activity_output', nodeId: 'missing', path: ['amount'] } }, factor: { literal: 2 } } }, workflow, catalog), /prior registered activity/);
  assert.throws(() => validateActivityBindings({ ...workflow.nodes[0], bindings: { amount: { literal: 1, from: { kind: 'run_input', path: ['amount'] } }, factor: { literal: 2 } } }, workflow, catalog), /invalid binding/);
  assert.throws(() => validateActivityBindings({ ...workflow.nodes[0], bindings: { amount: { from: { kind: 'run_input', path: ['__proto__'] } }, factor: { literal: 2 } } }, workflow, catalog), /invalid|unsafe/i);
  assert.throws(() => resolveActivityBindings(workflow.nodes[1].bindings, catalog.get('data.multiply@1').inputSchema, {
    runInputSchema: workflow.runInputSchema, runInput: { amount: 5, enabled: true, labels: ['ok'] }, activityOutputs: {},
  }), /not complete/);
});

test('amount, boolean and list outputs bind by declared path into a later typed activity', () => {
  const summaryInput = { type: 'object', properties: { multiplier: number, items: { type: 'array', items: { type: 'object', properties: {
    amount: number, active: bool, label: { type: 'string', maxLength: 80 },
  }, required: ['amount', 'active', 'label'], additionalProperties: false }, maxItems: 128 } }, required: ['items', 'multiplier'], additionalProperties: false };
  const summaryOutput = { type: 'object', properties: { amount: number, anyActive: bool, labels: list }, required: ['amount', 'anyActive', 'labels'], additionalProperties: false };
  const consumeInput = summaryOutput;
  const metadata = { resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
    cancellation: 'immediate', confirmation: 'result', reconciliation: 'none' };
  const catalog = createActivityCatalog([
    { ...metadata, ref: { id: 'example.summarize-items', revision: 1 }, inputSchema: summaryInput,
      outputSchema: summaryOutput, presentation: { label: 'Summarize items' } },
    { ...metadata, ref: { id: 'example.consume-summary', revision: 1 }, inputSchema: consumeInput,
      outputSchema: consumeInput, presentation: { label: 'Consume summary' } },
  ]);
  const workflow = normalizeWorkflow({ id: 'typed-summary', name: 'Typed summary',
    runInputSchema: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        amount: number, active: bool, label: { type: 'string', maxLength: 80 },
      }, required: ['amount', 'active', 'label'], additionalProperties: false }, maxItems: 128 },
    }, required: ['items'], additionalProperties: false },
    nodes: [
      { id: 'summary', name: 'Summary', kind: 'action', activity: { id: 'example.summarize-items', revision: 1 }, bindings: {
        items: { from: { kind: 'run_input', path: ['items'] } }, multiplier: { literal: 2 },
      } },
      { id: 'consume', name: 'Consume', kind: 'action', activity: { id: 'example.consume-summary', revision: 1 }, bindings: {
        amount: { from: { kind: 'activity_output', nodeId: 'summary', path: ['amount'] } },
        anyActive: { from: { kind: 'activity_output', nodeId: 'summary', path: ['anyActive'] } },
        labels: { from: { kind: 'activity_output', nodeId: 'summary', path: ['labels'] } },
      } },
    ], edges: [{ from: 'summary', to: 'consume', outcome: 'success' }],
  }, { publishing: true });
  validateActivityBindings(workflow.nodes[0], workflow, catalog);
  validateActivityBindings(workflow.nodes[1], workflow, catalog);
  const source = catalog.get('example.summarize-items@1');
  const target = catalog.get('example.consume-summary@1');
  assert.equal(source.outputSchema.properties.anyActive.type, 'boolean');
  assert.equal(source.outputSchema.properties.labels.type, 'array');
  assert.equal(target.inputSchema.properties.anyActive.type, 'boolean');
  assert.equal(target.inputSchema.properties.labels.type, 'array');
  const inputItems = [{ amount: 2, active: true, label: 'alpha' }, { amount: 3, active: false, label: 'beta' }];
  const firstInput = resolveActivityBindings(workflow.nodes[0].bindings, source.inputSchema, {
    runInputSchema: workflow.runInputSchema, runInput: { items: inputItems }, activityOutputs: {},
  });
  const firstOutput = validateActivityValue({ amount: 10, anyActive: true, labels: ['alpha', 'beta'] }, source.outputSchema);
  const secondInput = resolveActivityBindings(workflow.nodes[1].bindings, target.inputSchema, {
    runInputSchema: workflow.runInputSchema, runInput: { items: inputItems },
    activityOutputs: { summary: { status: 'completed', value: firstOutput, schema: source.outputSchema } },
  });
  assert.deepEqual(firstInput, { items: inputItems, multiplier: 2 });
  assert.deepEqual(secondInput, firstOutput);
});

test('activity binding resolution uses own-property paths and canonical digest ignores key order', () => {
  const schema = { type: 'object', properties: { amount: number }, required: ['amount'], additionalProperties: false };
  const bindings = { amount: { from: { kind: 'run_input', path: ['amount'] } } };
  assert.deepEqual(resolveActivityBindings(bindings, schema, { runInputSchema: schema, runInput: { amount: 12 } }), { amount: 12 });
  assert.equal(activityDigest({ b: 2, a: 1 }), activityDigest({ a: 1, b: 2 }));
  assert.throws(() => resolveActivityBindings(bindings, schema, { runInputSchema: schema, runInput: Object.create({ amount: 12 }) }), /not available/);
});

test('activity catalog rejects duplicates and invalid lifecycle metadata', () => {
  const descriptor = createActivityCatalog().get('data.multiply@1');
  assert.throws(() => createActivityCatalog([descriptor, descriptor]), /registered more than once/);
  assert.throws(() => createActivityCatalog([{ ...descriptor, effect: 'pure', cancellation: 'cooperative' }]), /lifecycle|Pure activity/);
});

test('activity registry is bounded and projects descriptor data without implementation fields', () => {
  const descriptor = createActivityCatalog().get('data.multiply@1');
  const entries = Array.from({ length: 129 }, (_, index) => ({ ...descriptor, ref: { id: `data.transform-${index}`, revision: 1 } }));
  assert.throws(() => createActivityCatalog(entries), /limited to 96/);
  const catalog = createActivityCatalog([{ ...descriptor, implementation: { execute: 'unreviewed' }, ignored: true }]);
  assert.equal(Object.hasOwn(catalog.get('data.multiply@1'), 'implementation'), false);
  assert.equal(Object.hasOwn(catalog.get('data.multiply@1'), 'ignored'), false);
});

test('object output compatibility rejects closed and typed target fields source may not safely provide', () => {
  const closedFoo = { type: 'object', properties: { foo: { type: 'string' } }, required: [], additionalProperties: false };
  const closedBar = { type: 'object', properties: { bar: { type: 'string' } }, required: [], additionalProperties: false };
  assert.equal(schemaAssignable(closedFoo, closedBar), false);
  const openSource = { type: 'object', properties: {}, required: [], additionalProperties: true };
  const typedTarget = { type: 'object', properties: { foo: { type: 'string' } }, required: [], additionalProperties: true };
  assert.equal(schemaAssignable(openSource, typedTarget), false);
});

test('workflow result references are typed, bounded, and pinned to activity metadata revision', () => {
  const catalog = createActivityCatalog();
  const workflow = normalizeWorkflow({ id: 'typed-result', name: 'Typed result',
    resultSchema: { type: 'object', properties: { amount: { type: 'number', minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000 } }, required: ['amount'], additionalProperties: false },
    resultBindings: { amount: { from: { kind: 'activity_output', nodeId: 'multiply', path: ['amount'] } } },
    nodes: [{ id: 'multiply', name: 'Multiply', kind: 'action', activity: { id: 'data.multiply', revision: 1 }, bindings: { amount: { literal: 3 }, factor: { literal: 2 } } }],
  }, { publishing: true });
  validateWorkflowResultBindings(workflow, catalog);
  validateActivityBindings(workflow.nodes[0], workflow, catalog);
  const pinnedNode = structuredClone(workflow.nodes[0]);
  const changedDescriptor = catalog.get('data.multiply@1');
  changedDescriptor.inputSchema.properties.amount.maximum = 5;
  const changed = createActivityCatalog([changedDescriptor]);
  assert.throws(() => validateActivityBindings(pinnedNode, workflow, changed), /descriptor changed/);
  assert.throws(() => validateWorkflowResultBindings({ ...workflow, resultBindings: { amount: { from: { kind: 'activity_output', nodeId: 'multiply', path: ['factor'] } } } }, catalog), /not declared/);
});

test('activity descriptors are immutable copies pinned to their exact registered revision', () => {
  const catalog = createActivityCatalog();
  const first = catalog.get('data.multiply@1');
  first.inputSchema.properties.amount.maximum = 1;
  first.resources.location = 'runner';
  const stillPinned = catalog.get({ id: 'data.multiply', revision: 1 });
  assert.equal(stillPinned.inputSchema.properties.amount.maximum, 1_000_000_000_000_000);
  assert.equal(stillPinned.resources.location, 'daemon');
});

function activityOwner() {
  const catalog = createActivityCatalog();
  const workflow = normalizeWorkflow({ id: 'attempt-flow', name: 'Attempt flow', nodes: [
    { id: 'transform', name: 'Transform', kind: 'action', activity: { id: 'data.multiply', revision: 1 }, bindings: {
      amount: { literal: 3 }, factor: { literal: 2 },
    } },
  ] });
  const run = { id: 'run-1', independentRun: true, projectId: 'p', organizationId: 'o', principal: { kind: 'user', userId: 'u' },
    workflow, flow: { id: 'run-1', workflowId: workflow.id, workflowVersion: 1, status: 'running', nodeId: 'transform', instance: 'instance-1', history: [] },
    attempt: { nodeId: 'transform', instance: 'instance-1', status: 'ready' }, runInput: {}, activityOutputs: {} };
  const state = { projects: [], workflowRuns: { [run.id]: run }, workflows: [], workflowDrafts: {} };
  const owner = createWorkflows({ state, save: async () => {}, defaultWorkflow: defaultWorkflowDefinition, normalize: normalizeWorkflow,
    validateBindings: () => {}, engine: {}, effects: {}, requestStop: async () => {}, automations: { snapshot: () => ({}) }, activityCatalog: catalog });
  return { owner, run, catalog, state };
}

test('completed attempt evidence cannot be downgraded by late callbacks or not-applied reconciliation', async () => {
  const { owner, run } = activityOwner();
  const ref = { id: 'data.multiply', revision: 1 };
  const identity = { instance: 'instance-1', nodeId: 'transform', ref, input: { amount: 3, factor: 2 },
    intent: { fixed: true }, idempotencyKey: 'run-1:instance-1' };
  await owner.recordActivityIntent(run, identity);
  await owner.recordActivityResult(run, { ...identity, status: 'completed', output: { amount: 6 } });
  const before = structuredClone(run.attempt);
  await assert.rejects(owner.recordActivityResult(run, { ...identity, status: 'waiting', output: { amount: 7 } }), /completed activity receipt/);
  await assert.rejects(owner.recordActivityResult(run, { ...identity, status: 'uncertain', message: 'late' }), /completed activity receipt/);
  await assert.rejects(owner.reconcileActivityAttempt(run, { ...identity, state: 'not_applied' }), /cannot be reconciled away/);
  assert.deepEqual(run.attempt, before);
  assert.equal(run.attempt.outputDigest, activityDigest({ amount: 6 }));
  assert.equal(run.attempt.status, 'completed');
});

test('waiting observations advance only against the exact prior observation digest', async () => {
  const { owner, run } = activityOwner();
  const ref = { id: 'data.multiply', revision: 1 };
  const identity = { instance: 'instance-1', nodeId: 'transform', ref, input: { amount: 3, factor: 2 },
    intent: { fixed: true }, idempotencyKey: 'run-1:instance-1' };
  await owner.recordActivityIntent(run, identity);
  await owner.recordActivityResult(run, { ...identity, status: 'waiting', output: { amount: 1 } });
  const previous = run.attempt.waitingOutputDigest;
  await assert.rejects(owner.recordActivityResult(run, { ...identity, status: 'waiting', output: { amount: 2 } }), /observation changed/);
  await owner.recordActivityResult(run, { ...identity, status: 'waiting', output: { amount: 2 }, expectedWaitingOutputDigest: previous });
  assert.equal(run.attempt.waitingOutput.amount, 2);
  assert.equal(run.attempt.intentDigest, activityDigest({ fixed: true }));
});

test('an effect-ledger identity mismatch is rejected before mutating the attempt', async () => {
  const { owner, run, state } = activityOwner();
  const key = `${run.id}:instance-1:transform`;
  state.workflowEffectLedger[key] = { status: 'pending', activityRef: { id: 'data.multiply', revision: 2 }, inputDigest: 'other' };
  const before = structuredClone(run.attempt);
  await assert.rejects(owner.recordActivityIntent(run, { instance: 'instance-1', nodeId: 'transform',
    ref: { id: 'data.multiply', revision: 1 }, input: { amount: 3, factor: 2 }, intent: { fixed: true }, idempotencyKey: 'run-1:instance-1' }), /identity does not match/);
  assert.deepEqual(run.attempt, before);
});
