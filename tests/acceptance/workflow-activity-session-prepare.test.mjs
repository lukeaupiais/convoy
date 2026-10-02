import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

test('session-backed activity preparation requires the current session owner before adapter preparation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-session-activity-prepare-'));
  let prepareCalls = 0;
  let preparedContext;
  const registration = {
    descriptor: {
      ref: { id: 'records.publish', revision: 1 },
      inputSchema: { type: 'object', properties: { recordId: { type: 'string', maxLength: 80 } }, required: ['recordId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { receiptId: { type: 'string', maxLength: 80 } }, required: ['receiptId'], additionalProperties: false },
      resources: { location: 'integration', adapterId: 'records-test' },
      effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
      cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
      presentation: { label: 'Publish record' },
    },
    implementation: {
      async prepare(input, _identity, context) { prepareCalls++; preparedContext = context; return { recordId: input.recordId }; },
      async dispatch() { return { state: 'completed', output: { receiptId: 'record-1' } }; },
      async confirm() { return { state: 'completed', output: { receiptId: 'record-1' } }; },
      async reconcile() { return { state: 'unknown' }; },
    },
  };
  const options = {
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { throw new Error('This workflow has no provider step.'); },
    workflowActivities: [registration],
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const client = 'session-activity-owner';
  const act = (action, input = {}) => runtime.command({ action, client, ...input });
  const chat = await act('createConversation', { requestId: 'session-activity-chat' });
  await act('claim', { sessionId: chat.sessionId });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: 'agent-platform' } });
  await act('saveWorkflow', { projectId: 'agent-platform', workflow: {
    id: 'session-record-publication', name: 'Session record publication', nodes: [
      { id: 'review', kind: 'human', name: 'Review record', prompt: 'Review the publication.' },
      { id: 'publish', kind: 'action', name: 'Publish', activity: { id: 'records.publish', revision: 1 },
        bindings: { recordId: { literal: 'record-1' } } },
    ], edges: [{ from: 'review', to: 'publish', outcome: 'approved' }],
  } });
  await act('configure', { sessionId: chat.sessionId, workflow: 'session-record-publication' });
  await act('startWorkflow', { sessionId: chat.sessionId });
  const snapshot = await runtime.snapshot(chat.sessionId);
  const flow = snapshot.sessions.find(value => value.id === chat.sessionId).flow;
  assert.ok(snapshot.sessions.some(value => value.id === chat.sessionId), 'the run already has a linked session');
  assert.equal(flow.status, 'waiting_gate');
  const reservationCommand = { workflowRunId: flow.id, gateInstance: flow.instance, targetNodeId: 'publish' };
  await assert.rejects(runtime.command({ action: 'prepareWorkflowActivity', client: 'other-client', ...reservationCommand }), /controlled|lease|control/i);
  assert.equal(prepareCalls, 0, 'a non-owner must be rejected before calling the pure adapter prepare seam');
  const prepared = await act('prepareWorkflowActivity', reservationCommand);
  assert.equal(prepared.preview.input.recordId, 'record-1');
  assert.equal(prepareCalls, 1);
  assert.equal(preparedContext.session, null);
  assert.equal(preparedContext.run.sessionId, undefined);
  assert.equal(preparedContext.owner, undefined);
});
