import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityCatalog, createWorkflows, defaultWorkflowDefinition, normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/index.mjs';

const descriptor = {
  ref: { id: 'test.record', revision: 1 },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
  resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false },
  cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
  presentation: { label: 'Record' },
};

function fixture() {
  const catalog = createActivityCatalog([descriptor]);
  const workflow = normalizeWorkflow({ id: 'plain-json', name: 'Plain JSON', nodes: [{ id: 'record', name: 'Record',
    kind: 'action', activity: descriptor.ref, bindings: {} }] });
  const run = { id: 'plain-json-run', independentRun: true, projectId: 'project-a', organizationId: 'org-a',
    principal: { kind: 'user', userId: 'operator-a' }, workflow,
    flow: { id: 'plain-json-run', workflowId: workflow.id, workflowVersion: 1, status: 'running', nodeId: 'record', instance: 'instance-a', history: [] },
    attempt: { nodeId: 'record', instance: 'instance-a', status: 'ready' }, runInput: {}, activityOutputs: {} };
  const state = { projects: [], workflowRuns: { [run.id]: run }, workflows: [], workflowDrafts: {} };
  let saves = 0;
  const owner = createWorkflows({ state, save: async () => { saves += 1; }, defaultWorkflow: defaultWorkflowDefinition,
    normalize: normalizeWorkflow, validateBindings: () => {}, engine: {}, effects: {}, requestStop: async () => {},
    automations: { snapshot: () => ({}) }, activityCatalog: catalog });
  const identity = { instance: 'instance-a', nodeId: 'record', ref: descriptor.ref, input: {},
    idempotencyKey: `${run.id}:instance-a` };
  return { owner, run, state, identity, get saves() { return saves; } };
}

test('activity intent rejects non-JSON values before changing the attempt or durable ledger', async () => {
  for (const value of [new Date('2026-01-01T00:00:00Z'), undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fixture();
    const before = structuredClone(f.state);
    const saves = f.saves;
    await assert.rejects(f.owner.recordActivityIntent(f.run, { ...f.identity, intent: { payload: value } }), /plain JSON|finite/i);
    assert.deepEqual(f.state, before);
    assert.equal(f.saves, saves);
  }
});
