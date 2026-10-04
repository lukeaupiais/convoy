import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowEffects } from '../../apps/daemon/src/control-plane/workflow-effects.mjs';

test('approval preparation receives bounded run facts, never an existing session or physical resources', async () => {
  const descriptor = {
    ref: { id: 'records.publish', revision: 1 },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resources: { location: 'agent', workspace: true, tools: ['read_file'] },
    effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Publish record' },
  };
  let preparedContext;
  const implementation = {
    async prepare(_input, _identity, context) { preparedContext = context; return { request: 'exact' }; },
    async dispatch() { throw new Error('Preparation must not dispatch.'); },
    async confirm() { return { state: 'unknown' }; },
    async reconcile() { return { state: 'unknown' }; },
  };
  const run = {
    id: 'run-a', organizationId: 'org-a', projectId: 'project-a', sessionId: 'session-a',
    principal: { kind: 'user', userId: 'operator-a' }, activeTicketId: 42,
    workflow: { id: 'workflow-a', version: 3 },
    flow: { status: 'waiting_gate', nodeId: 'review', instance: 'gate-a',
      decisionSubmissionRef: { nodeId: 'draft', instance: 'draft-a' },
      history: [{ nodeId: 'draft', instance: 'draft-a', to: 'review', outcome: 'success',
        submission: { nodeId: 'draft', details: { note: 'Reviewed content' }, summary: 'Draft' } }],
      ticketBindings: { last_created: 42 },
    },
    attempt: { nodeId: 'review', instance: 'gate-a', status: 'waiting' },
    runInput: {}, activityOutputs: {},
  };
  const state = { sessions: { 'session-a': {
    id: 'session-a', projectId: 'project-a', model: 'fixture', runnerId: 'runner-a',
    workspace: { id: 'workspace-a', path: '/private/workspace' },
    assignment: { state: 'running', token: 'private-assignment' },
    executionGrant: { digest: 'private-grant' },
  } } };
  const owner = {
    activityDescriptor: () => descriptor,
    resolveActivityInput: () => ({}),
  };
  const effects = createWorkflowEffects({
    state,
    catalog: {},
    injectedActivities: [{ descriptor, implementation }],
    getWorkflowOwner: () => owner,
    authorizeActivity: async (_run, _descriptor, _node, _reservation, options) => {
      assert.deepEqual(options, { phase: 'prepare' });
      return { resourcePins: { model: 'fixture' } };
    },
  });
  const prepared = await effects.prepareActivityIntent(run,
    { id: 'publish', name: 'Publish', kind: 'action', activity: descriptor.ref, bindings: {} },
    'target-a', { gateNodeId: 'review', gateInstance: 'gate-a' });

  assert.equal(preparedContext.session, null);
  assert.equal(preparedContext.owner, undefined);
  assert.deepEqual(preparedContext.run, {
    id: 'run-a', organizationId: 'org-a', projectId: 'project-a',
    principal: { kind: 'user', userId: 'operator-a' }, activeTicketId: 42,
    flow: { status: 'waiting_gate', nodeId: 'review', instance: 'gate-a',
      decisionSubmissionRef: { nodeId: 'draft', instance: 'draft-a' },
      history: [{ nodeId: 'draft', instance: 'draft-a', to: 'review', outcome: 'success',
        submission: { nodeId: 'draft', details: { note: 'Reviewed content' }, summary: 'Draft' } }],
      ticketBindings: { last_created: 42 } },
  });
  for (const key of ['sessionId', 'workspace', 'runnerId', 'assignment', 'executionGrant', 'model'])
    assert.equal(Object.hasOwn(preparedContext.run, key), false, `${key} is not exposed to prepare`);
  assert.deepEqual(prepared.preview.resources, { model: 'fixture' });
  assert.equal(prepared.preview.intent.request, 'exact');
});
