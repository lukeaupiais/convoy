import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const client = 'configured-human-evidence-acceptance';
const bounded = { type: 'string', maxLength: 160 };
const amount = { type: 'number', minimum: 0, maximum: 1_000_000 };
const orderDescriptor = {
  ref: { id: 'procurement.submit-order', revision: 1 },
  inputSchema: { type: 'object', properties: { quoteId: bounded, total: amount, deliveryDate: bounded }, required: ['quoteId', 'total', 'deliveryDate'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { receiptId: bounded, accepted: { type: 'boolean' } }, required: ['receiptId', 'accepted'], additionalProperties: false },
  resources: { location: 'integration', adapterId: 'procurement-api' }, effect: 'durable-effect',
  approval: { required: true, policy: 'workflow-gate' }, cancellation: 'reconcile-after-dispatch',
  confirmation: 'adapter-confirmed', reconciliation: 'adapter', presentation: { label: 'Submit purchase order' },
};

async function waitFor(act, workflowRunId, predicate) {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const run = await act('getWorkflowRun', { workflowRunId });
    if (predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow did not reach the expected state: ${JSON.stringify(await act('getWorkflowRun', { workflowRunId }))}`);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-human-evidence-'));
  const dispatches = [];
  const options = {
    directory, models: [{ id: 'fixture' }], workflowActivities: [{ descriptor: orderDescriptor, implementation: {
      async prepare(input, identity) { return { request: { ...input, idempotencyKey: identity.idempotencyKey } }; },
      async dispatch(context, input, intent) {
        dispatches.push({ runId: context.run.id, nodeId: context.node.id, instance: context.instance, input: structuredClone(input), intent: structuredClone(intent) });
        return { state: 'completed', output: { receiptId: `api-order-${input.quoteId}`, accepted: true } };
      },
      async confirm() { return { state: 'unknown' }; }, async reconcile() { return { state: 'unknown' }; },
    } }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () { assert.fail('Configured no-agent reviews must not invoke a provider.'); },
    runners: { execute: async () => { assert.fail('Integration evidence must not acquire a runner.'); }, close: async () => {} },
  };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, fields = {}, principal) => runtime.command({ action, client, ...fields }, principal);
  const organizations = {};
  const projects = {};
  for (const [key, displayName] of [['procurement', 'Procurement'], ['publication', 'Publication']]) {
    organizations[key] = await act('createOrganization', { slug: `human-${key}-${Date.now()}`, displayName, kind: 'team' });
    projects[key] = await act('saveProject', { organizationId: organizations[key].id, name: `${displayName} review` });
  }
  await runtime.close();
  const statePath = join(directory, 'state.json');
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  const ids = ['procurement-reviewer', 'procurement-other', 'procurement-viewer', 'procurement-runner', 'publication-editor', 'foreign-reviewer'];
  for (const id of ids) persisted.identity.users.push({ id, displayName: id, state: 'active', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(persisted));
  runtime = await createRuntime(options);
  const principals = Object.fromEntries(ids.map(id => [id, { kind: 'user', userId: id }]));
  for (const id of ids) {
    const key = id.startsWith('procurement') ? 'procurement' : id === 'publication-editor' ? 'publication' : 'foreign';
    const organizationId = key === 'foreign' ? organizations.publication.id : organizations[key].id;
    const projectId = key === 'foreign' ? projects.publication.id : projects[key].id;
    await act('createMembership', { organizationId, principal: principals[id], scope: { kind: 'organization', organizationId }, roles: ['member'] });
    await act('createMembership', { organizationId, principal: principals[id], scope: { kind: 'project', projectId }, roles: id === 'procurement-viewer' ? ['viewer'] : ['contributor'] });
    await act('selectActiveContext', { context: { organizationId, projectId } }, principals[id]);
  }
  const executionPrincipal = principals['procurement-runner'];
  return {
    act, projects, organizations, principals, executionPrincipal, dispatches,
    snapshot: principal => runtime.snapshot(undefined, client, principal),
    async writeEvidence(id, data) { await writeFile(join(directory, 'context-files', id), data); },
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
    async state() { return JSON.parse(await readFile(statePath, 'utf8')); },
  };
}

test('configured procurement and publication human tasks capture exact evidence, response, reviewer, and outcome without a session', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const buyer = f.principals['procurement-reviewer'];
  const otherBuyer = f.principals['procurement-other'];
  const viewer = f.principals['procurement-viewer'];
  const editor = f.principals['publication-editor'];
  const foreign = f.principals['foreign-reviewer'];

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('saveWorkflow', { projectId: f.projects.procurement.id, workflow: {
    id: 'vendor-quote-review', name: 'Vendor quote review', nodes: [
      { id: 'quote', kind: 'human', name: 'Review vendor quote', humanTask: {
        outcomes: [{ id: 'authorize_purchase', label: 'Authorize purchase', effect: 'approve_activity' }, { id: 'request_revision', label: 'Request a revised quote' }],
        form: { fields: [
          { id: 'total', label: 'Approved total', type: 'number', required: true, minimum: 1, maximum: 1_000_000 },
          { id: 'deliveryDate', label: 'Delivery date', type: 'date', required: true },
        ] }, reviewerPolicy: { permission: 'project.execute', userIds: [buyer.userId] }, dueAfterSeconds: 3600,
      } },
      { id: 'place-order', kind: 'action', name: 'Place approved order', activity: { id: orderDescriptor.ref.id, revision: 1 }, bindings: {
        quoteId: { literal: 'Q-2031' }, total: { from: { kind: 'human_response', nodeId: 'quote', path: ['total'] } },
        deliveryDate: { from: { kind: 'human_response', nodeId: 'quote', path: ['deliveryDate'] } },
      } },
      { id: 'receipt', kind: 'human', name: 'Confirm order receipt', humanTask: { outcomes: [{ id: 'recorded', label: 'Record receipt' }, { id: 'follow_up', label: 'Follow up' }] } },
    ], edges: [
      { from: 'quote', to: 'place-order', outcome: 'authorize_purchase' },
      { from: 'place-order', to: 'receipt', outcome: 'success' },
    ],
  } });

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.publication.id, projectId: f.projects.publication.id } });
  await f.act('saveWorkflow', { projectId: f.projects.publication.id, workflow: {
    id: 'edition-review', name: 'Edition review', nodes: [{ id: 'editorial', kind: 'human', name: 'Editorial decision', humanTask: {
      outcomes: [{ id: 'publish', label: 'Publish edition' }, { id: 'return_for_edit', label: 'Return for edit' }],
      form: { fields: [{ id: 'audience', label: 'Audience', type: 'choice', required: true, options: [
        { value: 'members', label: 'Members' }, { value: 'public', label: 'Public' },
      ] }] }, reviewerPolicy: { permission: 'project.write', userIds: [editor.userId] }, dueAfterSeconds: 7200,
    } }], edges: [],
  } });

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } }, buyer);
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } }, f.executionPrincipal);
  const purchase = await f.act('startWorkflowRun', { projectId: f.projects.procurement.id, workflowId: 'vendor-quote-review', workflowVersion: 1 }, f.executionPrincipal);
  const initial = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  assert.equal(initial.independent, true);
  assert.equal(initial.status, 'waiting_gate');
  assert.equal(initial.humanTaskReviewerEligible, true, JSON.stringify(initial));
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, viewer)).humanTaskReviewerEligible, false,
    'the exact run projection reports a project viewer as ineligible without granting decision authority');
  assert.match(initial.humanTaskDueAt, /^\d{4}-/);
  assert.deepEqual((await f.snapshot(buyer)).sessions, []);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, otherBuyer);
  await assert.rejects(f.act('submitWorkflowHumanResponse', { workflowRunId: purchase.workflowRunId, instance: initial.instance, values: {} }, otherBuyer), /not authorized|permission|review/i);
  await f.act('releaseWorkflowRun', { workflowRunId: purchase.workflowRunId }, otherBuyer);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  await assert.rejects(f.act('submitWorkflowHumanResponse', { workflowRunId: purchase.workflowRunId, instance: initial.instance, values: { total: 50, deliveryDate: '2026-02-31' } }, buyer), /valid date/i);
  await assert.rejects(f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, foreign), /authorized|available|active/i);
  const beforeUpload = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  const quote = Buffer.from('%PDF-1.7\nprocurement quote\n%%EOF').toString('base64');
  await assert.rejects(f.act('captureWorkflowEvidence', { workflowRunId: purchase.workflowRunId, instance: 'stale-gate-instance',
    producer: 'document', name: 'stale.pdf', mime: 'application/pdf', data: quote }, buyer), /current human task instance/i);
  await assert.rejects(f.act('captureWorkflowEvidence', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    nodeId: 'missing-node', attemptInstance: 'invented-attempt', producer: 'document', name: 'invented.pdf', mime: 'application/pdf', data: quote }, buyer), /current human task instance/i);
  assert.deepEqual((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer)).evidence, beforeUpload.evidence,
    'stale and invented document source identities are rejected before adding evidence references');
  const quoteEvidence = await f.act('captureWorkflowEvidence', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    producer: 'document', name: 'Q-2031.pdf', mime: 'application/pdf', data: quote }, buyer);
  assert.equal(quoteEvidence.source.producer, 'document');
  const quoteReadback = await f.act('readWorkflowEvidence', { workflowRunId: purchase.workflowRunId, evidenceId: quoteEvidence.id }, buyer);
  assert.equal(Buffer.from(quoteReadback.data, 'base64').toString('utf8'), '%PDF-1.7\nprocurement quote\n%%EOF');
  const readOnlyEvidence = await f.act('readWorkflowEvidence', { workflowRunId: purchase.workflowRunId, evidenceId: quoteEvidence.id }, viewer);
  assert.equal(readOnlyEvidence.evidence.digest, quoteEvidence.digest, 'project readers retain read-only access to evidence without reviewer eligibility');
  const response = await f.act('submitWorkflowHumanResponse', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    values: { total: 1840, deliveryDate: '2026-10-15' } }, buyer);
  assert.deepEqual(response.values, { total: 1840, deliveryDate: '2026-10-15' });
  assert.deepEqual(response.evidenceIds, [quoteEvidence.id]);
  const responseSnapshot = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  assert.equal(responseSnapshot.humanTaskDueAt, initial.humanTaskDueAt, 'editing task responses must not reset the relative deadline');
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, viewer)).humanResponses, undefined,
    'project readers can inspect run history/evidence without receiving private form responses for a task they cannot review');
  await f.act('releaseWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, otherBuyer);
  await assert.rejects(f.act('prepareWorkflowActivity', { workflowRunId: purchase.workflowRunId,
    gateInstance: initial.instance, targetNodeId: 'place-order' }, otherBuyer), /not authorized|review/i,
  'a project executor excluded by the configured reviewer policy cannot obtain private prepared material');
  await assert.rejects(f.act('prepareWorkflowHumanReview', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    responseId: response.id, outcomeId: 'authorize_purchase', targetNodeId: 'place-order' }, otherBuyer), /not authorized|permission|review/i);
  await f.act('releaseWorkflowRun', { workflowRunId: purchase.workflowRunId }, otherBuyer);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  const review = await f.act('prepareWorkflowHumanReview', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    responseId: response.id, outcomeId: 'authorize_purchase', targetNodeId: 'place-order' }, buyer);
  assert.deepEqual(review.response.values, { total: 1840, deliveryDate: '2026-10-15' });
  assert.equal(review.evidence[0].digest, quoteEvidence.digest);
  assert.deepEqual(review.reservation.preview.input, { quoteId: 'Q-2031', total: 1840, deliveryDate: '2026-10-15' });
  assert.equal(f.dispatches.length, 0, 'submission and prepared review do not apply the integration effect');
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    outcomeId: 'authorize_purchase', responseId: response.id, reviewedMaterialDigest: '0'.repeat(64) }, buyer), /material changed|prepare and review/i);
  await f.writeEvidence(quoteEvidence.id, Buffer.from('tampered quote'));
  await assert.rejects(f.act('readWorkflowEvidence', { workflowRunId: purchase.workflowRunId, evidenceId: quoteEvidence.id }, buyer), /integrity|changed/i);
  await f.writeEvidence(quoteEvidence.id, Buffer.from('%PDF-1.7\nprocurement quote\n%%EOF'));

  const revisedQuote = Buffer.from('%PDF-1.7\nrevised procurement quote\n%%EOF').toString('base64');
  const revisedEvidence = await f.act('captureWorkflowEvidence', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    producer: 'document', name: 'Q-2031-revised.pdf', mime: 'application/pdf', data: revisedQuote }, buyer);
  const revisedResponse = await f.act('submitWorkflowHumanResponse', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    values: { total: 1895, deliveryDate: '2026-10-20' } }, buyer);
  assert.deepEqual(revisedResponse.evidenceIds, [quoteEvidence.id, revisedEvidence.id]);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    outcomeId: 'authorize_purchase', responseId: response.id, reviewedMaterialDigest: review.materialDigest,
    activityReservationId: review.reservation.id, activityReservationDigest: review.reservation.digest }, buyer), /current human response|submit the current|material changed/i);
  assert.equal(f.dispatches.length, 0);
  const revisedReview = await f.act('prepareWorkflowHumanReview', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    responseId: revisedResponse.id, outcomeId: 'authorize_purchase', targetNodeId: 'place-order' }, buyer);
  assert.notEqual(revisedReview.reservation.id, review.reservation.id);
  assert.deepEqual(revisedReview.reservation.preview.input, { quoteId: 'Q-2031', total: 1895, deliveryDate: '2026-10-20' });

  const buyerMembership = (await f.snapshot(buyer)).memberships.find(value => value.principal.userId === buyer.userId && value.scope.kind === 'project' && value.scope.projectId === f.projects.procurement.id);
  assert.ok(buyerMembership);
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } });
  await f.act('updateMembership', { organizationId: f.organizations.procurement.id, membershipId: buyerMembership.id, state: 'suspended' });
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    outcomeId: 'authorize_purchase', responseId: revisedResponse.id, reviewedMaterialDigest: revisedReview.materialDigest,
    activityReservationId: revisedReview.reservation.id, activityReservationDigest: revisedReview.reservation.digest }, buyer), /authorized|active|available/i);
  await f.act('updateMembership', { organizationId: f.organizations.procurement.id, membershipId: buyerMembership.id, state: 'active' });
  await f.restart();
  await f.act('selectActiveContext', { context: { organizationId: f.organizations.procurement.id, projectId: f.projects.procurement.id } }, buyer);
  const recovered = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  assert.equal(recovered.instance, initial.instance);
  assert.equal(recovered.humanTaskDueAt, initial.humanTaskDueAt);
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    outcomeId: 'authorize_purchase', responseId: response.id, reviewedMaterialDigest: review.materialDigest,
    activityReservationId: review.reservation.id, activityReservationDigest: review.reservation.digest }, buyer), /claim workflow run control first/i);
  await f.act('claimWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer)).status, 'waiting_gate');
  const freshReview = await f.act('prepareWorkflowHumanReview', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    responseId: revisedResponse.id, outcomeId: 'authorize_purchase', targetNodeId: 'place-order' }, buyer);
  assert.equal(freshReview.reservation.id, revisedReview.reservation.id);
  await f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: initial.instance,
    outcomeId: 'authorize_purchase', responseId: revisedResponse.id, reviewedMaterialDigest: freshReview.materialDigest,
    activityReservationId: freshReview.reservation.id, activityReservationDigest: freshReview.reservation.digest }, buyer);
  const receiptGate = await waitFor(f.act, purchase.workflowRunId, run => run.nodeId === 'receipt' && run.status === 'waiting_gate');
  assert.equal(f.dispatches.length, 1);
  assert.deepEqual(f.dispatches[0].input, { quoteId: 'Q-2031', total: 1895, deliveryDate: '2026-10-20' });
  const attempt = receiptGate.activityAttempts.find(item => item.nodeId === 'place-order' && item.status === 'completed');
  assert.ok(attempt);
  const apiSnapshot = await f.act('captureWorkflowActivityReceipt', { workflowRunId: purchase.workflowRunId, nodeId: 'place-order', attemptInstance: attempt.instance }, buyer);
  assert.equal(apiSnapshot.source.producer, 'api_snapshot', 'integration outputs are classified by the owner, never by the caller');
  const readback = await f.act('readWorkflowEvidence', { workflowRunId: purchase.workflowRunId, evidenceId: apiSnapshot.id }, buyer);
  assert.equal(readback.evidence.digest, apiSnapshot.digest);
  assert.deepEqual(JSON.parse(Buffer.from(readback.data, 'base64').toString('utf8')), { receiptId: 'api-order-Q-2031', accepted: true });
  const finalResponse = await f.act('submitWorkflowHumanResponse', { workflowRunId: purchase.workflowRunId, instance: receiptGate.instance, values: {} }, buyer);
  const finalReview = await f.act('prepareWorkflowHumanReview', { workflowRunId: purchase.workflowRunId, instance: receiptGate.instance,
    responseId: finalResponse.id, outcomeId: 'recorded' }, buyer);
  await f.act('decideWorkflowRun', { workflowRunId: purchase.workflowRunId, instance: receiptGate.instance,
    outcomeId: 'recorded', responseId: finalResponse.id, reviewedMaterialDigest: finalReview.materialDigest }, buyer);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer)).status, 'completed');
  const finalPurchase = await f.act('getWorkflowRun', { workflowRunId: purchase.workflowRunId }, buyer);
  assert.ok(finalPurchase.humanResponses.some(value => value.id === response.id), 'old proposals remain part of the immutable run history');
  assert.ok(finalPurchase.evidence.some(value => value.id === quoteEvidence.id));
  assert.equal((await f.act('readWorkflowEvidence', { workflowRunId: purchase.workflowRunId, evidenceId: apiSnapshot.id }, buyer)).evidence.digest, apiSnapshot.digest,
    'an earlier immutable receipt remains readable after the run produces later history');

  await f.act('selectActiveContext', { context: { organizationId: f.organizations.publication.id, projectId: f.projects.publication.id } }, editor);
  const edition = await f.act('startWorkflowRun', { projectId: f.projects.publication.id, workflowId: 'edition-review', workflowVersion: 1 }, editor);
  const editorial = await f.act('getWorkflowRun', { workflowRunId: edition.workflowRunId }, editor);
  await f.act('claimWorkflowRun', { workflowRunId: edition.workflowRunId }, editor);
  for (const decision of ['approve', 'requestChanges']) {
    await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: edition.workflowRunId, instance: editorial.instance,
      decision, feedback: 'Return this edition for a revision.' }, editor), /configured human task requires a reviewed response/i);
  }
  await assert.rejects(f.act('decideWorkflowRun', { workflowRunId: edition.workflowRunId, instance: editorial.instance,
    outcomeId: 'approved' }, editor), /human outcome|review material|response/i);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: edition.workflowRunId }, editor)).status, 'waiting_gate');
  await assert.rejects(f.act('submitWorkflowHumanResponse', { workflowRunId: edition.workflowRunId, instance: editorial.instance, values: { audience: 'private' } }, editor), /invalid|enum/i);
  const choice = await f.act('submitWorkflowHumanResponse', { workflowRunId: edition.workflowRunId, instance: editorial.instance, values: { audience: 'public' } }, editor);
  const publicationReview = await f.act('prepareWorkflowHumanReview', { workflowRunId: edition.workflowRunId, instance: editorial.instance,
    responseId: choice.id, outcomeId: 'return_for_edit' }, editor);
  await f.act('decideWorkflowRun', { workflowRunId: edition.workflowRunId, instance: editorial.instance,
    outcomeId: 'return_for_edit', responseId: choice.id, reviewedMaterialDigest: publicationReview.materialDigest }, editor);
  assert.equal((await f.act('getWorkflowRun', { workflowRunId: edition.workflowRunId }, editor)).status, 'completed');
  assert.equal(f.dispatches.length, 1, 'publication outcome labels alone must not authorize an external effect');
  assert.deepEqual((await f.snapshot(editor)).sessions, []);
  const stored = await f.state();
  const decision = stored.workflowRuns[purchase.workflowRunId].decisions.find(value => value.outcomeId === 'authorize_purchase');
  assert.equal(decision.responseId, revisedResponse.id);
  assert.equal(decision.materialDigest, freshReview.materialDigest);
  assert.equal(decision.principal.userId, buyer.userId);
});

test('session-backed configured human tasks reject legacy approve and request-changes commands', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.act('saveWorkflow', { workflow: { id: 'session-configured-review', name: 'Session configured review', nodes: [
    { id: 'review', kind: 'human', name: 'Review', humanTask: {
      outcomes: [{ id: 'release', label: 'Release' }, { id: 'revise', label: 'Revise' }],
      form: { fields: [{ id: 'decisionNote', label: 'Decision note', type: 'text', required: true }] },
    } },
  ], edges: [] } });
  const ticket = await f.act('createTicket', { requestId: 'session-configured-task', projectId: 'agent-platform', title: 'Review a supplier quote' });
  await f.act('runTicket', { requestId: 'session-configured-task-run', ticketId: ticket.id, revision: ticket.revision,
    workflowId: 'session-configured-review', workflowVersion: 1, model: 'fixture', mode: 'new' });
  const session = (await f.snapshot()).sessions.find(item => item.activeTicketId === ticket.id);
  assert.equal(session.flow.status, 'waiting_gate');
  await f.act('claim', { sessionId: session.id });
  for (const [action, payload] of [
    ['approveGate', { sessionId: session.id }],
    ['requestChanges', { sessionId: session.id, feedback: 'Please revise' }],
    ['decideWorkflowRun', { workflowRunId: session.workflowRunId, decision: 'approve' }],
    ['decideWorkflowRun', { workflowRunId: session.workflowRunId, decision: 'requestChanges', feedback: 'Please revise' }],
  ]) {
    await assert.rejects(f.act(action, { ...payload, instance: session.flow.instance }),
      /configured human task requires a reviewed response/i, `${action} must not bypass the configured form/outcome decision`);
  }
  const unchanged = (await f.snapshot()).sessions.find(item => item.id === session.id);
  assert.equal(unchanged.flow.status, 'waiting_gate');
  assert.equal(unchanged.flow.instance, session.flow.instance);
  assert.deepEqual(unchanged.flow.history, []);
});

test('published legacy gates retain their approve path across read, restart, and re-normalization', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.act('saveWorkflow', { workflow: { id: 'legacy-session-review', name: 'Legacy session review', nodes: [
    { id: 'review', kind: 'human', name: 'Review', decisionLabels: { approved: 'Accept legacy review' } },
  ], edges: [] } });
  const ticket = await f.act('createTicket', { requestId: 'legacy-session-task', projectId: 'agent-platform', title: 'Review a historical workflow' });
  await f.act('runTicket', { requestId: 'legacy-session-task-run', ticketId: ticket.id, revision: ticket.revision,
    workflowId: 'legacy-session-review', workflowVersion: 1, model: 'fixture', mode: 'new' });
  let session = (await f.snapshot()).sessions.find(item => item.activeTicketId === ticket.id);
  assert.equal(session.flow.status, 'waiting_gate');
  const read = await f.act('getWorkflowRun', { workflowRunId: session.workflowRunId });
  assert.equal(read.status, 'waiting_gate');
  await f.act('claim', { sessionId: session.id });
  await f.act('approveGate', { sessionId: session.id, instance: session.flow.instance });
  await f.restart();
  session = (await f.snapshot()).sessions.find(item => item.activeTicketId === ticket.id);
  assert.equal(session.flow.status, 'completed');
  const completed = await f.act('getWorkflowRun', { workflowRunId: session.workflowRunId });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.history.at(-1).outcome, 'approved');
});
