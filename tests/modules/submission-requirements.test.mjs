import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowEngine,
  normalizeWorkflow,
} from '../../apps/daemon/src/modules/workflows/workflows.mjs';
import {
  normalizeSubmissionRequirements,
  validateSubmissionRequirements,
} from '../../apps/daemon/src/modules/workflows/submission-requirements.mjs';

const rules = {
  publish: { fields: ['audience', 'selfCheck'], minReferences: 1 },
  investigate: { fields: ['question', 'decisionImpact'], minReferences: 0 },
};
const ref = { path: 'articles/story.md', startLine: 2, endLine: 3 };
const file = {
  text: 'Second\nThird',
  startLine: 2,
  endLine: 3,
  totalLines: 3,
  nextColumn: null,
  sha256: 'a'.repeat(64),
};
const args = {
  summary: 'Ready',
  outcome: 'publish',
  artifacts: [],
  details: { audience: 'Readers', selfCheck: 'Checked opposing evidence' },
  references: [ref],
};
function fixture(readReference = async () => file) {
  const workflow = normalizeWorkflow({
    id: 'editorial',
    name: 'Editorial review',
    nodes: [
      {
        id: 'draft',
        name: 'Draft',
        kind: 'agent',
        permissions: 'read',
        prompt: 'Review source',
        submissionRequirements: rules,
      },
      { id: 'review', name: 'Review', kind: 'human', prompt: 'Review' },
    ],
    edges: [
      { from: 'draft', to: 'review', outcome: 'publish' },
      { from: 'draft', to: 'review', outcome: 'investigate' },
    ],
  });
  const session = {
    id: 'fixture',
    workflow: { ...workflow, version: 1 },
    messages: [],
    checks: [],
    events: [],
  };
  const engine = createWorkflowEngine({
    state: { sessions: { fixture: session } },
    save: async () => {},
    event: (s, type, data) => s.events.push({ type, ...data }),
    readReference,
    launch: () => true,
  });
  return { session, engine };
}
test('outcome requirements validate configuration and keep unrelated workflow vocabulary', () => {
  assert.deepEqual(normalizeSubmissionRequirements(rules), rules);
  for (const value of [
    {},
    { publish: { fields: ['x', 'x'], minReferences: 1 } },
    { publish: { fields: [], minReferences: 9 } },
    { publish: { fields: ['../x'], minReferences: 1 } },
  ])
    assert.throws(() => normalizeSubmissionRequirements(value));
});
test('configured fields and references are validated before any transition or read', async () => {
  let reads = 0;
  for (const invalid of [
    { ...args, details: {} },
    { ...args, references: [] },
    { ...args, details: { ...args.details, extra: 'value' } },
    { ...args, references: [{ ...ref, path: '../outside' }] },
    { ...args, references: [{ ...ref, endLine: 1 }] },
    { ...args, references: [ref, ref] },
  ]) {
    await assert.rejects(
      validateSubmissionRequirements({ submissionRequirements: rules }, invalid, async () => {
        reads++;
        return file;
      }),
    );
  }
  assert.equal(reads, 0);
});
test('missing, out-of-range and truncated source references reject and can be repaired', async () => {
  let response = { ...file, totalLines: 2 };
  const { session, engine } = fixture(async () => response);
  await engine.start(session);
  await engine.pump();
  for (const bad of [
    { ...file, totalLines: 2 },
    { ...file, nextColumn: 30 },
    { ...file, sha256: '' },
  ]) {
    response = bad;
    await assert.rejects(engine.submit(session, session.flow.instance, args), /Reference/);
    assert.equal(session.flow.nodeId, 'draft');
    assert.equal(session.flow.status, 'running');
    assert.equal(session.flow.lastSubmission, undefined);
    assert.equal(session.events.at(-1).type, 'submission_rejected');
  }
  response = file;
  await engine.submit(session, session.flow.instance, args);
  assert.equal(session.status, 'waiting_gate');
  assert.deepEqual(session.flow.lastSubmission.details, args.details);
  assert.equal(session.flow.lastSubmission.references[0].text, file.text);
  assert.equal(session.flow.previousEvidence.references[0].sha256, file.sha256);
});
test('a pause during reference inspection cannot publish a submission', async () => {
  let release;
  const { session, engine } = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await engine.start(session);
  await engine.pump();
  const pending = engine.submit(session, session.flow.instance, args);
  session.flow.status = 'paused';
  release(file);
  await assert.rejects(pending, /changed during source validation/);
  assert.equal(session.flow.lastSubmission, undefined);
  assert.equal(session.flow.nodeId, 'draft');
});

test('declared material internal gaps prevent advancement until resolved, with optional compatibility', async () => {
  const { session, engine } = fixture();
  session.workflow.nodes[0].submissionRequirements.publish.requireInvestigationAssessment = true;
  await engine.start(session);
  await engine.pump();
  await assert.rejects(engine.submit(session, session.flow.instance, args), /Supply investigation/);
  const question = { question: 'Does editorial policy require consent?', material: true,
    internallyAnswerable: true, status: 'unresolved', resolution: '', nextAction: 'Read the consent policy' };
  const submission = { ...args, investigation: { questions: [question] } };
  await assert.rejects(engine.submit(session, session.flow.instance, submission), /Read the consent policy/);
  assert.equal(session.flow.status, 'running');
  assert.equal(session.flow.lastSubmission, undefined);
  submission.investigation.questions[0] = { ...question, status: 'resolved', resolution: 'Policy requires consent; recorded consent is present.' };
  await engine.submit(session, session.flow.instance, submission);
  assert.equal(session.status, 'waiting_gate');
  assert.deepEqual(session.flow.lastSubmission.investigation, submission.investigation);
  submission.investigation.questions[0].resolution = 'mutated';
  assert.notEqual(session.flow.lastSubmission.investigation.questions[0].resolution, 'mutated');

  const node = { submissionRequirements: { publish: { ...rules.publish, requireInvestigationAssessment: true } } };
  for (const change of [{material: false}, {internallyAnswerable: false}]) {
    await validateSubmissionRequirements(node, { ...args, investigation: { questions: [{ ...question, ...change }] } }, async () => file);
  }
  for (const investigation of [{}, {questions: [{...question, material: 'false'}]}, {questions: [{...question, nextAction: ''}]}, {questions: [{...question, status: 'resolved'}]}]) {
    await assert.rejects(validateSubmissionRequirements(node, {...args, investigation}, async () => file));
  }
  assert.throws(() => normalizeSubmissionRequirements({ publish: { ...rules.publish, requireInvestigationAssessment: 'true' } }));
  await validateSubmissionRequirements({ submissionRequirements: rules }, args, async () => file);
});

test('opt-in claim evidence binds material resolutions to captured references with explicit limits', async () => {
  const { session, engine } = fixture();
  Object.assign(session.workflow.nodes[0].submissionRequirements.publish, {
    requireInvestigationAssessment: true, requireClaimEvidence: true,
  });
  await engine.start(session);
  await engine.pump();
  const question = { question: 'Does the policy require consent?', material: true,
    internallyAnswerable: true, status: 'resolved', resolution: 'The policy requires consent.', nextAction: '' };
  const evidence = {references: [0], establishes: 'The policy source explicitly requires consent.', unverified: 'Actual enforcement by the publishing service was not exercised.'};
  const submission = {...args, investigation: {questions: [question]}};
  await assert.rejects(engine.submit(session, session.flow.instance, {...submission, investigation: {questions: []}}), /at least one material/);
  for (const bad of [undefined, {...evidence, references: [1]}, {...evidence, references: [-1]}, {...evidence, references: [0,0]}, {...evidence, establishes: ' '}, {...evidence, unverified: ''}]) {
    submission.investigation.questions[0] = {...question, ...(bad ? {evidence: bad} : {})};
    await assert.rejects(engine.submit(session, session.flow.instance, submission), /evidence/);
    assert.equal(session.flow.lastSubmission, undefined);
    assert.equal(session.flow.status, 'running');
  }
  submission.investigation.questions[0] = {...question, evidence};
  await engine.submit(session, session.flow.instance, submission);
  assert.equal(session.status, 'waiting_gate');
  assert.deepEqual(session.flow.lastSubmission.investigation.questions[0].evidence, evidence);
  evidence.establishes = 'Changed after capture';
  assert.notEqual(session.flow.lastSubmission.investigation.questions[0].evidence.establishes, evidence.establishes);
  assert.throws(() => normalizeSubmissionRequirements({publish: {...rules.publish, requireClaimEvidence: true}}));
  assert.throws(() => normalizeSubmissionRequirements({publish: {...rules.publish, requireInvestigationAssessment: true, requireClaimEvidence: 'true'}}));
});
