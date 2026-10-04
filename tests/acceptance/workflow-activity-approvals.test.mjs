import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const client = 'workflow-activity-approval-acceptance';
const amount = { type: 'number', minimum: 0, maximum: 1_000_000 };
const boundedText = { type: 'string', maxLength: 180 };
const descriptor = (id, properties) => ({
  ref: { id, revision: 1 },
  inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  outputSchema: { type: 'object', properties: { receiptId: boundedText, accepted: { type: 'boolean' } }, required: ['receiptId', 'accepted'], additionalProperties: false },
  resources: { location: 'integration', adapterId: `${id}.adapter` },
  effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
  cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
  presentation: { label: id },
});

async function waitForRun(act, workflowRunId, predicate, description) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = await act('getWorkflowRun', { workflowRunId });
    if (predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${description}: ${JSON.stringify(await act('getWorkflowRun', { workflowRunId }))}`);
}

async function within(promise, description, timeout = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), timeout); })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-activity-approval-'));
  const dispatches = [];
  const preparations = [];
  const registrations = [
    {
      descriptor: descriptor('procurement.authorize-order', { orderId: boundedText, amount }),
      implementation: {
        async prepare(input, identity) {
          preparations.push({ activityId: 'procurement.authorize-order', input: structuredClone(input) });
          return { request: { ...input, idempotencyKey: identity.idempotencyKey } };
        },
        async dispatch(context, input, intent) {
          dispatches.push({ activityId: 'procurement.authorize-order', runId: context.run.id,
            nodeId: context.node.id, instance: context.instance, input: structuredClone(input), intent: structuredClone(intent) });
          return { state: 'completed', output: { receiptId: `purchase-${input.orderId}`, accepted: true } };
        },
        async confirm() { return { state: 'completed', output: { receiptId: 'confirmed', accepted: true } }; },
        async reconcile() { return { state: 'unknown' }; },
      },
    },
    {
      descriptor: descriptor('publication.release-edition', { editionId: boundedText, releaseWindow: boundedText }),
      implementation: {
        async prepare(input, identity) {
          preparations.push({ activityId: 'publication.release-edition', input: structuredClone(input) });
          return { release: { ...input, requestKey: identity.idempotencyKey } };
        },
        async dispatch(context, input, intent) {
          dispatches.push({ activityId: 'publication.release-edition', runId: context.run.id,
            nodeId: context.node.id, instance: context.instance, input: structuredClone(input), intent: structuredClone(intent) });
          return { state: 'completed', output: { receiptId: `edition-${input.editionId}`, accepted: true } };
        },
        async confirm() { return { state: 'completed', output: { receiptId: 'confirmed', accepted: true } }; },
        async reconcile() { return { state: 'unknown' }; },
      },
    },
  ];
  const options = {
    directory, models: [{ id: 'fixture' }], workflowActivities: registrations,
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Human-only approval workflows must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('Integration approval workflows must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const projects = {};
  const organizations = {};
  for (const [key, name] of [['procurement', 'Procurement'], ['publication', 'Publication']]) {
    organizations[key] = await act('createOrganization', { slug: `approval-${key}-${Date.now()}`, displayName: name, kind: 'team' });
    projects[key] = await act('saveProject', { organizationId: organizations[key].id, name: `${name} review` });
  }
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  const userIds = ['procurement-reviewer', 'procurement-standby', 'procurement-viewer', 'publication-reviewer'];
  for (const id of userIds) persisted.identity.users.push({ id, displayName: id, state: 'active', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(persisted));
  runtime = await createRuntime(options);
  const principals = Object.fromEntries(userIds.map(id => [id, { kind: 'user', userId: id }]));
  for (const [id, principal] of Object.entries(principals)) {
    const key = id.startsWith('procurement') ? 'procurement' : 'publication';
    const organizationId = organizations[key].id;
    const projectId = projects[key].id;
    await act('createMembership', { organizationId, principal,
      scope: { kind: 'organization', organizationId }, roles: ['member'] });
    await act('createMembership', { organizationId, principal,
      scope: { kind: 'project', projectId }, roles: id === 'procurement-viewer' ? ['viewer'] : ['contributor'] });
    await act('selectActiveContext', { context: { organizationId, projectId } }, principal);
  }
  return {
    act, projects, organizations, principals, preparations, dispatches,
    async snapshot(principal) { return runtime.snapshot(undefined, client, principal); },
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
    async state() { return JSON.parse(await readFile(statePath, 'utf8')); },
    async close() { await runtime?.close(); runtime = null; },
  };
}

function workflow(id, activityId, values) {
  const bindings = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { literal: value }]));
  return { id, name: id, nodes: [
    { id: 'review', kind: 'human', name: 'Review request', prompt: 'Review the exact configured request.' },
    { id: 'apply', kind: 'action', name: 'Apply approved request', activity: { id: activityId, revision: 1 }, bindings },
  ], edges: [{ from: 'review', to: 'apply', outcome: 'approved' }] };
}

test('exact prepared integration approval is tenant-scoped, restart-safe, and bound to its pinned target', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const procurement = f.principals['procurement-reviewer'];
  const standby = f.principals['procurement-standby'];
  const viewer = f.principals['procurement-viewer'];
  const outsider = f.principals['publication-reviewer'];
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: workflow('purchase-order-review', 'procurement.authorize-order', { orderId: 'PO-442', amount: 1840 }) });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.publication.id, projectId: f.projects.publication.id } });
  await f.act('saveWorkflow', { projectId: f.projects.publication.id, workflow: workflow('edition-release-review', 'publication.release-edition', { editionId: 'field-notes-8', releaseWindow: '2026-Q4' }) });

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  const workload = await f.act('createWorkloadIdentity', { organizationId: f.organizations.procurement.id, displayName: 'Purchase approval execution' });
  const runPrincipal = { kind: 'workload', workloadIdentityId: workload.id };
  await f.act('createMembership', { organizationId: f.organizations.procurement.id, principal: runPrincipal,
    scope: { kind: 'organization', organizationId: f.organizations.procurement.id }, roles: ['member'] });
  await f.act('createMembership', { organizationId: f.organizations.procurement.id, principal: runPrincipal,
    scope: { kind: 'project', projectId: f.projects.procurement.id }, roles: ['contributor'] });
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } }, runPrincipal);
  const purchase = await f.act('startWorkflowRun', { projectId: f.projects.procurement.id, workflowId: 'purchase-order-review', workflowVersion: 1 }, runPrincipal);
  const purchaseGate = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  assert.equal(purchaseGate.status, 'waiting_gate');
  assert.equal((await f.snapshot(procurement)).sessions.length, 0);
  assert.equal(f.preparations.length, 0);
  assert.equal(f.dispatches.length, 0);

  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, procurement), /Claim workflow run control first|claim/i);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  const procurementMembership = (await f.snapshot(procurement)).memberships.find(value => value.principal.userId === procurement.userId &&
    value.scope.kind === 'project' && value.scope.projectId === f.projects.procurement.id);
  assert.ok(procurementMembership);
  await f.act('updateMembership', { organizationId: f.organizations.procurement.id, membershipId: procurementMembership.id, state: 'suspended' });
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, procurement), /authorized|active|available/i);
  await f.act('updateMembership', { organizationId: f.organizations.procurement.id, membershipId: procurementMembership.id, state: 'active' });
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  await assert.rejects(f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, standby), /controlled|another client/i);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'missing-target' }, procurement), /configured approved activity route|target/i);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: 'stale-gate-instance', targetNodeId: 'apply' }, procurement), /no longer the active workflow step|changed/i);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, standby), /controlled|lease|control/i);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, outsider), /authorized|available|active/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve' }, procurement), /prepare.*exact activity intent/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve', activityReservationId: 'forged', activityReservationDigest: '0'.repeat(64) }, outsider), /authorized|available|active/i);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement)).status, 'waiting_gate');
  assert.equal(f.preparations.length, 0);
  assert.equal(f.dispatches.length, 0);

  const prepared = await f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, procurement);
  assert.match(prepared.id, /^[0-9a-f-]{36}$/i);
  assert.match(prepared.digest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.preview.activity, 'procurement.authorize-order');
  assert.deepEqual(prepared.preview.input, { orderId: 'PO-442', amount: 1840 });
  assert.deepEqual(prepared.preview.intent.request, { orderId: 'PO-442', amount: 1840, idempotencyKey: `${purchase.workflowRunId}:${(await f.state()).workflowRuns[purchase.workflowRunId].activityReservations.find(item => item.id === prepared.id).targetInstance}` });
  assert.deepEqual(f.preparations, [{ activityId: 'procurement.authorize-order', input: { orderId: 'PO-442', amount: 1840 } }]);
  assert.equal(f.dispatches.length, 0, 'preparing the exact intent has no external effect');
  const beforeRestart = await f.state();
  const savedRun = beforeRestart.workflowRuns[purchase.workflowRunId];
  const reservation = savedRun.activityReservations.find(item => item.id === prepared.id);
  assert.equal(reservation.gateInstance, purchaseGate.instance);
  assert.equal(reservation.targetNodeId, 'apply');
  assert.deepEqual(reservation.intent.request, { orderId: 'PO-442', amount: 1840, idempotencyKey: `${purchase.workflowRunId}:${reservation.targetInstance}` });

  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: 'stale-instance', decision: 'approve', activityReservationId: prepared.id, activityReservationDigest: prepared.digest }, procurement), /changed|stale/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve', activityReservationId: prepared.id }, procurement), /exact prepared activity reservation/i);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve', activityReservationId: prepared.id, activityReservationDigest: 'f'.repeat(64) }, procurement), /exact prepared activity reservation/i);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement)).status, 'waiting_gate');
  assert.equal(f.dispatches.length, 0);

  const readOnlyRun = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, viewer);
  const readOnlySnapshot = await f.snapshot(viewer);
  const assertReviewMaterialHidden = run => {
    for (const reservation of run.activityReservations ?? []) {
      assert.equal(Object.hasOwn(reservation, 'preview'), false);
      assert.equal(Object.hasOwn(reservation, 'input'), false);
      assert.equal(Object.hasOwn(reservation, 'intent'), false);
    }
    for (const item of run.history ?? []) assert.equal(Object.hasOwn(item, 'activityReservation'), false);
  };
  assertReviewMaterialHidden(readOnlyRun);
  const listedRun = readOnlySnapshot.workflowRuns.find(run => run.id === purchase.workflowRunId);
  assert.ok(listedRun);
  assertReviewMaterialHidden(listedRun);
  assert.deepEqual(readOnlySnapshot.sessions, [], 'the independent run has no session projection carrying approval material');
  await f.act('releaseWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, viewer);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, viewer), /authorized|permission|execute/i,
    'project-viewer role cannot prepare an external effect even while holding run control');

  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, baseVersion: 1,
    workflow: workflow('purchase-order-review', 'procurement.authorize-order', { orderId: 'PO-999', amount: 9900 }) });
  await f.restart();
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } }, procurement);
  const recovered = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  assert.equal(recovered.workflowVersion, 1);
  assert.equal(recovered.instance, purchaseGate.instance);
  assert.equal(recovered.status, 'waiting_gate');
  assert.equal(recovered.lease, null);
  assert.equal(recovered.activityReservations.find(item => item.id === prepared.id).digest, prepared.digest);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve', activityReservationId: prepared.id, activityReservationDigest: prepared.digest }, procurement), /claim workflow run control first/i);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement);
  const recoveredPreparation = await f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId, gateInstance: purchaseGate.instance, targetNodeId: 'apply' }, procurement);
  assert.equal(recoveredPreparation.id, prepared.id);
  assert.equal(recoveredPreparation.digest, prepared.digest);
  assert.deepEqual(recoveredPreparation.preview, prepared.preview, 'only the authorized leased preparation command returns the cached exact review material');
  await f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: purchaseGate.instance, decision: 'approve', activityReservationId: prepared.id, activityReservationDigest: prepared.digest }, procurement);
  const purchaseDone = await waitForRun(f.act, purchase.workflowRunId, run => ['completed', 'failed', 'interrupted'].includes(run.status), 'purchase authorization did not settle');
  assert.equal(purchaseDone.status, 'completed', JSON.stringify((await f.state()).workflowRuns[purchase.workflowRunId]));
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.dispatches[0].instance, reservation.targetInstance);
  assert.equal(f.dispatches[0].nodeId, 'apply');
  assert.equal(f.dispatches[0].intent.request.idempotencyKey, `${purchase.workflowRunId}:${reservation.targetInstance}`);
  assert.equal(purchaseDone.attempt.instance, reservation.targetInstance);
  assert.equal(purchaseDone.attempt.activityRef.id, 'procurement.authorize-order');
  assert.match(purchaseDone.attempt.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(purchaseDone.attempt.outputDigest, /^[a-f0-9]{64}$/);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, procurement)).workflowVersion, 1);
  assert.equal(f.dispatches.length, 1, 'restart and lease reacquisition do not replay the approved effect');

  const editionActor = f.principals['publication-reviewer'];
  const edition = await f.act('startWorkflowRun', { projectId: f.projects.publication.id, workflowId: 'edition-release-review', workflowVersion: 1 }, editionActor);
  const editionGate = await f.act('getWorkflowRun', { workflowRunId: edition.workflowRunId }, editionActor);
  assert.equal(editionGate.status, 'waiting_gate');
  assert.equal(editionGate.independent, true);
  assert.equal((await f.snapshot(editionActor)).sessions.length, 0);
  await f.act('claimWorkflowRun', { workflowRunId: edition.workflowRunId }, editionActor);
  const releaseIntent = await f.act('prepareWorkflowActivity', { workflowRunId: edition.workflowRunId, gateInstance: editionGate.instance, targetNodeId: 'apply' }, editionActor);
  await f.act('decideWorkflowRun', { workflowRunId: edition.workflowRunId, instance: editionGate.instance, decision: 'approve', activityReservationId: releaseIntent.id, activityReservationDigest: releaseIntent.digest }, editionActor);
  const editionDone = await waitForRun(f.act, edition.workflowRunId, run => ['completed', 'failed', 'interrupted'].includes(run.status), 'publication release did not settle');
  assert.equal(editionDone.status, 'completed', JSON.stringify(editionDone));
  assert.equal(editionDone.attempt.activityRef.id, 'publication.release-edition');
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.dispatches[1].runId, edition.workflowRunId);
  assert.equal(f.dispatches[1].input.editionId, 'field-notes-8');
  assert.deepEqual((await f.snapshot(editionActor)).sessions, []);
});
