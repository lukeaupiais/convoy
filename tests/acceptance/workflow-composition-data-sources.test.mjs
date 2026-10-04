import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const toolResult = (args) => ({
  type: 'result',
  message: { role: 'assistant', content: [{ type: 'toolCall', id: 'submit-result', name: 'submit_step', arguments: args }], stopReason: 'stop', timestamp: Date.now() },
});

async function waitForRun(act, workflowRunId, terminal) {
  const deadline = Date.now() + 8000;
  let run;
  do {
    run = await act('getWorkflowRun', { workflowRunId });
    if (terminal(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Workflow run did not settle: ${JSON.stringify(run)}`);
}

test('terminal result accepts only captured agent submissions and configured human responses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-composition-data-sources-'));
  let calls = 0;
  const parserRef = { id: 'documents.parse-extracted-amount', revision: 1 };
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {
      calls++;
      if (calls === 1) yield toolResult({ summary: 'Measured amount', outcome: 'extracted', details: { amount: '27.50' }, artifacts: [], references: [] });
      else if (calls === 3) yield toolResult({ summary: 'Summary-only assessment', artifacts: [] });
      else yield { type: 'result', message: { role: 'assistant', content: 'No structured submission was produced.', stopReason: 'stop', timestamp: Date.now() } };
    },
    runners: { execute: async () => assert.fail('These terminal source proofs do not require a runner.'), close: async () => {} },
    workflowActivities: [{ descriptor: {
      ref: parserRef,
      inputSchema: { type: 'object', properties: {
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        amountText: { type: 'string', minLength: 1, maxLength: 4000 },
      }, required: ['summary', 'amountText'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 4000 }, amount: { type: 'number', minimum: 0, maximum: 100_000 }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['summary', 'amount', 'confidence'], additionalProperties: false },
      resources: { location: 'integration', adapterId: 'document-parser' }, effect: 'pure', approval: { required: false }, cancellation: 'immediate',
      confirmation: 'result', reconciliation: 'none', presentation: { label: 'Parse extracted amount' },
    }, implementation: {
      async prepare(input) { return { inputDigest: JSON.stringify(input) }; },
      async dispatch(_context, input) { return { state: 'completed', output: { summary: input.summary, amount: Number(input.amountText), confidence: 0.96 } }; },
    } }],
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, fields = {}) => runtime.command({ action, client: 'composition-data-source-proof', ...fields });
  const project = await act('saveProject', { name: 'Procurement source proof' });
  await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });

  const resultSchema = { type: 'object', properties: {
    summary: { type: 'string', minLength: 1, maxLength: 4000 }, amount: { type: 'number', minimum: 0, maximum: 100_000 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
  }, required: ['summary', 'amount', 'confidence'], additionalProperties: false };
  const agentWorkflow = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'capture-agent-assessment', name: 'Capture agent assessment', projectId: project.id,
    resultSchema, resultBindings: {
      summary: { from: { kind: 'activity_output', nodeId: 'parse', path: ['summary'] } },
      amount: { from: { kind: 'activity_output', nodeId: 'parse', path: ['amount'] } },
      confidence: { from: { kind: 'activity_output', nodeId: 'parse', path: ['confidence'] } },
    },
    nodes: [{ id: 'assess', name: 'Assess purchase', kind: 'agent', model: 'fixture', permissions: 'none',
      submissionRequirements: { extracted: { fields: ['amount'], minReferences: 0 } }, prompt: 'Return the configured assessment fields.' },
    { id: 'parse', name: 'Parse extracted amount', kind: 'action', activity: parserRef,
      bindings: {
        summary: { from: { kind: 'agent_submission', nodeId: 'assess', path: ['summary'] } },
        amountText: { from: { kind: 'agent_submission', nodeId: 'assess', path: ['details', 'amount'] } },
      } }], edges: [{ from: 'assess', to: 'parse', outcome: 'extracted' }],
  } });
  const started = await act('startWorkflowRun', { projectId: project.id, workflowId: agentWorkflow.id, workflowVersion: agentWorkflow.version });
  const completed = await waitForRun(act, started.workflowRunId, run => ['completed', 'failed'].includes(run.status));
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const firstState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(firstState.workflowRuns[started.workflowRunId].result, { summary: 'Measured amount', amount: 27.5, confidence: 0.96 },
    'the typed result comes from a parser bound to the accepted, completed submit_step receipt');
  assert.equal(completed.result, undefined, 'project-read snapshots expose only the immutable result digest');
  assert.equal(completed.workflowRunResultEligible, false, 'project readers without run control cannot read the private result');
  await assert.rejects(act('getWorkflowRunResult', { workflowRunId: started.workflowRunId }), /lease|control/i,
    'reading the validated result requires the exact run lease');
  await act('claimWorkflowRun', { workflowRunId: started.workflowRunId });
  assert.equal((await act('getWorkflowRun', { workflowRunId: started.workflowRunId })).workflowRunResultEligible, true);
  const result = await act('getWorkflowRunResult', { workflowRunId: started.workflowRunId });
  assert.deepEqual(result.result, { summary: 'Measured amount', amount: 27.5, confidence: 0.96 });
  assert.equal(result.resultDigest, completed.resultDigest);
  await assert.rejects(runtime.command({ action: 'getWorkflowRunResult', client: 'unleased-data-reader', workflowRunId: started.workflowRunId }),
    /lease|control/i, 'another client cannot read the result without the run lease');
  assert.equal((await runtime.command({ action: 'getWorkflowRun', client: 'unleased-data-reader', workflowRunId: started.workflowRunId })).workflowRunResultEligible, false);

  const missingSubmission = await act('saveWorkflow', { projectId: project.id, workflow: {
    ...agentWorkflow, id: 'missing-agent-submission', name: 'Missing agent submission', version: undefined,
  } });
  const unsubmitted = await act('startWorkflowRun', { projectId: project.id, workflowId: missingSubmission.id, workflowVersion: missingSubmission.version });
  const waiting = await waitForRun(act, unsubmitted.workflowRunId, run => ['completed', 'failed', 'awaiting_submission', 'paused'].includes(run.status));
  assert.notEqual(waiting.status, 'completed', 'an unsubmitted agent turn cannot fabricate a successful terminal result');
  const secondState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(secondState.workflowRuns[unsubmitted.workflowRunId].result, undefined);

  const summaryOnly = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'summary-only-agent-result', name: 'Summary-only agent result', projectId: project.id,
    resultSchema: { type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['summary'], additionalProperties: false },
    resultBindings: { summary: { from: { kind: 'agent_submission', nodeId: 'summarize', path: ['summary'] } } },
    nodes: [{ id: 'summarize', name: 'Summarize', kind: 'agent', model: 'fixture', permissions: 'none', prompt: 'Return a concise assessment.' }], edges: [],
  } });
  const summaryRun = await act('startWorkflowRun', { projectId: project.id, workflowId: summaryOnly.id, workflowVersion: summaryOnly.version });
  const summaryCompleted = await waitForRun(act, summaryRun.workflowRunId, run => ['completed', 'failed'].includes(run.status));
  const summaryState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(summaryCompleted.status, 'completed', JSON.stringify({ run: summaryCompleted,
    owner: summaryState.workflowRuns[summaryRun.workflowRunId],
    session: summaryState.sessions?.[summaryCompleted.sessionId]?.events?.slice(-10) }));
  assert.deepEqual(summaryState.workflowRuns[summaryRun.workflowRunId].result, { summary: 'Summary-only assessment' });

  const humanWorkflow = await act('saveWorkflow', { projectId: project.id, workflow: {
    id: 'capture-reviewed-amount', name: 'Capture reviewed amount', projectId: project.id,
    resultSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 0, maximum: 100_000 } }, required: ['amount'], additionalProperties: false },
    resultBindingsByTerminal: { 'review-amount': { amount: { from: { kind: 'human_response', nodeId: 'review-amount', path: ['approvedAmount'] } } } },
    nodes: [{ id: 'review-amount', name: 'Review amount', kind: 'human', humanTask: {
      outcomes: [{ id: 'changes_requested', label: 'Record revised amount' }, { id: 'declined', label: 'Decline' }],
      form: { fields: [{ id: 'approvedAmount', label: 'Approved amount', type: 'number', required: true, minimum: 0, maximum: 100_000 }] },
    } }], edges: [],
  } });
  const humanRun = await act('startWorkflowRun', { projectId: project.id, workflowId: humanWorkflow.id, workflowVersion: humanWorkflow.version });
  await act('claimWorkflowRun', { workflowRunId: humanRun.workflowRunId });
  const gate = await act('getWorkflowRun', { workflowRunId: humanRun.workflowRunId });
  const response = await act('submitWorkflowHumanResponse', { workflowRunId: humanRun.workflowRunId, instance: gate.instance,
    values: { approvedAmount: 72.5 } });
  const review = await act('prepareWorkflowHumanReview', { workflowRunId: humanRun.workflowRunId, instance: gate.instance,
    responseId: response.id, outcomeId: 'changes_requested' });
  await assert.rejects(act('decideWorkflowRun', { workflowRunId: humanRun.workflowRunId, instance: gate.instance,
    outcomeId: 'changes_requested', responseId: 'stale-response' }), /current response|prepare|review/i);
  await act('decideWorkflowRun', { workflowRunId: humanRun.workflowRunId, instance: gate.instance,
    outcomeId: 'changes_requested', responseId: response.id, reviewedMaterialDigest: review.materialDigest });
  const humanState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(humanState.workflowRuns[humanRun.workflowRunId].flow.status, 'completed',
    'configured custom outcomes do not acquire legacy repair semantics by name');
  assert.deepEqual(humanState.workflowRuns[humanRun.workflowRunId].result, { amount: 72.5 });
});
