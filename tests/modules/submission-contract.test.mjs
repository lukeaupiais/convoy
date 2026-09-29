import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import { submissionContract, submissionToolSchema, validateSubmissionContract, createWorkflowEngine } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { toolRegistry } from '../../apps/daemon/src/modules/library/tool-registry.mjs';
const base = toolRegistry.find(t => t.name === 'submit_step').inputSchema;
const node = {id: 'assess', kind: 'agent', name: 'Assess'};
const workflow = outcomes => ({nodes: [node], edges: outcomes.map(outcome => ({from: node.id, to: 'review', outcome}))});
const args = outcome => ({summary: 'Evidence and rationale', artifacts: [], ...(outcome === undefined ? {} : {outcome})});
test('unrelated routing vocabularies produce matching schemas and validation', () => {
  for (const outcomes of [['publish', 'revise'], ['reimburse', 'decline']]) {
    const contract = submissionContract(workflow(outcomes), node);
    const schema = submissionToolSchema(base, contract);
    const check = new Ajv().compile(schema);
    assert.deepEqual(schema.properties.outcome.enum, outcomes);
    assert.ok(schema.required.includes('outcome'));
    for (const outcome of [...outcomes, undefined, 'progress', 'I recommend publishing']) {
      assert.equal(check(args(outcome)), outcomes.includes(outcome));
      if (outcomes.includes(outcome)) assert.equal(validateSubmissionContract(contract, args(outcome)), outcome);
      else assert.throws(() => validateSubmissionContract(contract, args(outcome)), e => {
        assert.deepEqual(e.submissionFeedback.allowed, outcomes);
        assert.equal(e.submissionFeedback.code, 'invalid_outcome');
        assert.match(e.message, /finish_incomplete/); return true;
      });
    }
  }
  assert.equal(base.properties.outcome.enum, undefined);
});
test('terminal success, repair edges and catch-all routes preserve routing semantics', () => {
  for (const outcomes of [[], ['changes_requested'], ['success'], ['*'], ['default']]) {
    const contract = submissionContract(workflow(outcomes), node);
    assert.equal(validateSubmissionContract(contract, args()), 'success');
    assert.ok(new Ajv().compile(submissionToolSchema(base, contract))(args()));
    if (outcomes.includes('*') || outcomes.includes('default')) {
      assert.equal(contract.outcomes, null);
      assert.equal(validateSubmissionContract(contract, args('custom:route')), 'custom:route');
      assert.throws(() => validateSubmissionContract(contract, args('prose with spaces')));
    }
  }
});
test('invalid and stale submissions never capture or seal evidence', async () => {
  let captures = 0;
  const s = {id: 's', workflow: workflow(['publish']), flow: {instance: 'current', nodeId: node.id, status: 'running'}};
  const engine = createWorkflowEngine({state: {sessions: {s}}, save: async () => {}, event: () => {}, captureArtifacts: async () => {captures++;}, sealEvidence: async () => {captures++;}});
  await assert.rejects(engine.submit(s, 'stale', args('publish')), /step has changed/);
  await assert.rejects(engine.submit(s, 'current', args('Publish the article')), /exact workflow outcome/);
  await assert.rejects(engine.submit(s, 'current', {summary: 'Done', outcome: 'publish'}), /Supply artifacts/);
  assert.equal(captures, 0);
  assert.equal(s.flow.status, 'running');
});

test('required artifacts and bounded summary are reflected in schema and validation', () => {
  const contract = submissionContract(workflow(['publish']), {...node, artifact: {path: 'report.md'}});
  const check = new Ajv().compile(submissionToolSchema(base, contract));
  const valid = {...args('publish'), artifacts: ['report.md']};
  assert.ok(check(valid));
  assert.equal(validateSubmissionContract(contract, valid), 'publish');
  for (const invalid of [args('publish'), {...valid, summary: '   '}, {...valid, summary: 'x'.repeat(4001)}]) {
    assert.equal(check(invalid), false);
    assert.throws(() => validateSubmissionContract(contract, invalid));
  }
});
