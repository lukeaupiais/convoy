import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

async function waitFor(act, workflowRunId) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const run = await act('getWorkflowRun', { workflowRunId });
    if (['completed', 'failed'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow did not settle: ${JSON.stringify(await act('getWorkflowRun', { workflowRunId }))}`);
}

test('a retained run lease does not keep result access after project execute authority is revoked', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-result-authority-'));
  const activity = {
    ref: { id: 'inventory.count', revision: 1 },
    inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resources: { location: 'daemon' }, effect: 'pure', approval: { required: false }, cancellation: 'immediate',
    confirmation: 'result', reconciliation: 'none', presentation: { label: 'Count inventory' },
  };
  const options = {
    directory, models: [{ id: 'fixture' }], workflowActivities: [{ descriptor: activity, implementation: {
      async prepare(input) { return structuredClone(input); },
      async dispatch(_context, input) { return { state: 'completed', output: structuredClone(input) }; },
    } }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('This data workflow must not allocate an agent session.'); },
    runners: { execute: async () => assert.fail('This data workflow must not acquire a runner.'), close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const client = 'workflow-result-authority';
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const organization = await act('createOrganization', { slug: `result-access-${Date.now()}`, displayName: 'Result access', kind: 'team' });
  const project = await act('saveProject', { organizationId: organization.id, name: 'Inventory review' });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } });
  const workflow = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'inventory-count-result', name: 'Inventory count result', projectId: project.id,
    runInputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['count'], additionalProperties: false },
    resultBindings: { count: { from: { kind: 'activity_output', nodeId: 'count', path: ['count'] } } },
    nodes: [{ id: 'count', name: 'Count inventory', kind: 'action', activity: activity.ref,
      bindings: { count: { from: { kind: 'run_input', path: ['count'] } } } }], edges: [],
  } });
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  const viewer = { kind: 'user', userId: 'inventory-viewer' };
  persisted.identity.users.push({ id: viewer.userId, displayName: 'Inventory viewer', state: 'active', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(persisted));
  runtime = await createRuntime(options);

  await act('createMembership', { organizationId: organization.id, principal: viewer,
    scope: { kind: 'organization', organizationId: organization.id }, roles: ['member'] });
  const projectMembership = await act('createMembership', { organizationId: organization.id, principal: viewer,
    scope: { kind: 'project', projectId: project.id }, roles: ['contributor'] });
  await act('selectActiveContext', { context: { organizationId: organization.id, projectId: project.id } }, viewer);
  const started = await act('startWorkflowRun', { projectId: project.id, workflowId: workflow.id,
    workflowVersion: workflow.version, runInput: { count: 314 } }, viewer);
  const completed = await waitFor((action, fields) => act(action, fields, viewer), started.workflowRunId);
  assert.equal(completed.status, 'completed');
  await act('claimWorkflowRun', { workflowRunId: started.workflowRunId }, viewer);
  assert.deepEqual((await act('getWorkflowRunResult', { workflowRunId: started.workflowRunId }, viewer)).result, { count: 314 });
  assert.equal((await act('getWorkflowRun', { workflowRunId: started.workflowRunId }, viewer)).workflowRunResultEligible, true);

  await act('updateMembership', { organizationId: organization.id, membershipId: projectMembership.id, roles: ['viewer'] });
  const afterRevocation = await act('getWorkflowRun', { workflowRunId: started.workflowRunId }, viewer);
  assert.equal(afterRevocation.lease.ownedByCurrentCaller, true, 'the exact client lease remains held');
  assert.equal(afterRevocation.workflowRunResultEligible, false, 'current execute authority is checked separately from run control');
  await assert.rejects(act('getWorkflowRunResult', { workflowRunId: started.workflowRunId }, viewer), /permission|authorized/i);
});
