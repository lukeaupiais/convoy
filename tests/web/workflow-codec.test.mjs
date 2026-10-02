import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/workflows/workflow-codec.ts', import.meta.url),
  'utf8',
);
const isolatedSource = source.replace(
  "import { newId } from '../../shared/lib/browser';",
  "const newId = () => '00000000-0000-4000-8000-000000000000';",
);
const js = ts.transpileModule(isolatedSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { fromWorkflow, toWorkflow, validateWorkflow, reorderWorkflowStages, insertWorkflowStage, workflowStageOrder, canAddPresentationBinding } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('workflow codec uses the browser-compatible ID seam rather than requiring randomUUID', () => {
  assert.match(
    source,
    /import\s+\{\s*newId\s*\}\s+from\s+['"]\.\.\/\.\.\/shared\/lib\/browser['"]/,
  );
  assert.doesNotMatch(source, /globalThis\.crypto\.randomUUID/);
});

test('stage view follows the entry and primary edges when storage order differs', () => {
  const graph = fromWorkflow({ id: 'ordered', name: 'Ordered', entryNode: 'start', nodes: [
    { id: 'end', kind: 'human', name: 'End', prompt: 'Review' },
    { id: 'alternate', kind: 'human', name: 'Alternate', prompt: 'Review' },
    { id: 'start', kind: 'agent', name: 'Start', prompt: 'Begin' },
  ], edges: [
    { id: 'primary', from: 'start', to: 'end', outcome: 'success' },
    { id: 'other', from: 'start', to: 'alternate', outcome: 'failed' },
  ] });
  const ordered = workflowStageOrder(graph);
  assert.deepEqual(ordered.mainPath.map((node) => node.id), ['start', 'end']);
  assert.deepEqual(ordered.otherRoutes.map((node) => node.id), ['alternate']);
});

test('workflow editor codec round-trips canonical graph nodes without leaking editor-only shapes', () => {
  const wire = {
    id: 'flow',
    name: 'Typed flow',
    schemaVersion: 3,
    version: 2,
    maxRevisions: 3,
    entryNode: 'branch',
    triggers: [],
    nodes: [
      {
        id: 'branch',
        kind: 'branch',
        name: 'Route',
        advance: 'automatic',
        x: 1,
        y: 2,
        condition: {
          source: 'ticket',
          field: 'priority',
          equals: 3,
          trueOutcome: 'high',
          falseOutcome: 'normal',
        },
      },
      {
        id: 'done',
        kind: 'human',
        name: 'Approve',
        prompt: 'Review.',
        advance: 'manual',
        x: 3,
        y: 4,
      },
    ],
    edges: [
      { id: 'edge', from: 'branch', to: 'done', outcome: 'high' },
      { id: 'fallback', from: 'branch', to: 'done', outcome: 'normal' },
    ],
    steps: [],
  };
  const editor = fromWorkflow(wire);
  assert.equal(editor.nodes[0].type, 'branch');
  assert.equal(editor.nodes[0].condition.valueType, 'number');
  assert.equal(editor.nodes[1].type, 'approval');
  const encoded = toWorkflow(editor);
  assert.equal(encoded.nodes[0].kind, 'branch');
  assert.equal(encoded.nodes[0].condition.equals, 3);
  assert.equal(encoded.nodes[1].kind, 'human');
  assert.equal('type' in encoded.nodes[0], false);
  assert.deepEqual(validateWorkflow(editor), []);
});

test('decision labels survive draft codec round trips and invalid metadata is rejected', () => {
  const draft = fromWorkflow({ id: 'configured-review', name: 'Configured review', nodes: [
    { id: 'review', kind: 'human', name: 'Review result', prompt: 'Review the submitted result.',
      decisionLabels: { approved: 'Record estimate', changes_requested: 'Recalculate' } },
  ], edges: [] });
  assert.deepEqual(toWorkflow(draft).nodes[0].decisionLabels,
    { approved: 'Record estimate', changes_requested: 'Recalculate' });
  assert.deepEqual(validateWorkflow(draft), []);
  draft.nodes[0].decisionLabels = { publish: 'Publish' };
  assert.match(validateWorkflow(draft).join(' '), /supported human outcomes/);
});

test('workflow editor validation catches unreachable nodes and invalid numeric branches before publication', () => {
  const editor = fromWorkflow({
    id: 'bad',
    name: 'Bad',
    nodes: [
      {
        id: 'branch',
        type: 'branch',
        name: 'Route',
        prompt: '',
        x: 0,
        y: 0,
        condition: {
          source: 'ticket',
          field: 'priority',
          operator: 'equals',
          value: 'nope',
          valueType: 'number',
          trueOutcome: 'yes',
          falseOutcome: 'no',
        },
      },
      { id: 'orphan', type: 'approval', name: 'Orphan', prompt: 'Review', x: 1, y: 1 },
    ],
    edges: [],
    entryNode: 'branch',
    maxRevisions: 3,
    triggers: [],
  });
  assert.match(validateWorkflow(editor).join(' '), /valid number/);
});

test('reordering stages changes the primary delivery path without losing revision routes', () => {
  const graph = fromWorkflow({
    id: 'delivery',
    name: 'Delivery',
    entryNode: 'plan',
    maxRevisions: 3,
    triggers: [],
    nodes: [
      { id: 'plan', type: 'agent', name: 'Plan', prompt: 'Plan.', x: 0, y: 0 },
      { id: 'approve', type: 'approval', name: 'Approve', prompt: 'Review.', x: 1, y: 0 },
      { id: 'build', type: 'agent', name: 'Build', prompt: 'Build.', x: 2, y: 0 },
    ],
    edges: [
      { id: 'plan-approve', from: 'plan', to: 'approve', outcome: 'success' },
      { id: 'approved-build', from: 'approve', to: 'build', outcome: 'approved' },
      { id: 'revise-plan', from: 'approve', to: 'plan', outcome: 'changes_requested' },
    ],
  });
  const reordered = reorderWorkflowStages(graph, ['plan', 'build', 'approve']);
  assert.equal(reordered.entryNode, 'plan');
  assert.deepEqual(
    reordered.edges.map(({ from, outcome, to }) => [from, outcome, to]),
    [
      ['approve', 'changes_requested', 'plan'],
      ['plan', 'success', 'build'],
      ['build', 'success', 'approve'],
    ],
  );
});

test('inserting a stage splices it into the primary route and preserves alternate routes', () => {
  const graph = fromWorkflow({
    id: 'delivery',
    name: 'Delivery',
    entryNode: 'approve',
    maxRevisions: 3,
    triggers: [],
    nodes: [
      { id: 'approve', type: 'approval', name: 'Approve', prompt: 'Review.', x: 0, y: 0 },
      { id: 'build', type: 'agent', name: 'Build', prompt: 'Build.', x: 1, y: 0 },
    ],
    edges: [
      { id: 'approved-build', from: 'approve', to: 'build', outcome: 'approved' },
      { id: 'revise-approve', from: 'approve', to: 'approve', outcome: 'changes_requested' },
    ],
  });
  const verify = { id: 'verify', type: 'check', name: 'Verify', prompt: 'Check.', x: 2, y: 0 };
  const inserted = insertWorkflowStage(graph, 'approve', verify);
  assert.deepEqual(
    inserted.nodes.map((node) => node.id),
    ['approve', 'verify', 'build'],
  );
  assert.deepEqual(
    inserted.edges.map(({ from, outcome, to }) => [from, outcome, to]),
    [
      ['approve', 'changes_requested', 'approve'],
      ['approve', 'approved', 'verify'],
      ['verify', 'success', 'build'],
    ],
  );
});

test('workflow editor preserves an exact capability profile through graph round trips', () => {
  const profile = { id: 'editorial', version: 3 };
  const graph = fromWorkflow({ id: 'article', name: 'Article', capabilityProfile: profile, nodes: [{ id: 'review', type: 'approval', name: 'Review' }] });
  assert.deepEqual(toWorkflow(graph).capabilityProfile, profile);
});

test('agent investigation settings survive an editor round trip', () => {
  const wire = {id: 'inspect', name: 'Inspect', nodes: [{id: 'inspect', kind: 'agent', name: 'Inspect', prompt: 'Inspect', maxRounds: 12, finalizationRounds: 2, reasoningEffort: 'medium', summaryHeadings: ['Evidence', 'Unknowns']}], edges: []};
  const roundTrip = toWorkflow(fromWorkflow(wire));
  for (const key of ['maxRounds', 'finalizationRounds', 'reasoningEffort', 'summaryHeadings']) assert.deepEqual(roundTrip.nodes[0][key], wire.nodes[0][key]);
});

test('outcome-specific requirements survive editor publication without dropping policies', () => {
  const policy = {publish: {fields: ['audience', 'selfCheck'], minReferences: 1, requireInvestigationAssessment: true, requireClaimEvidence: true}};
  const wire = {id: 'editorial', name: 'Editorial', nodes: [{id: 'draft', kind: 'agent', name: 'Draft', prompt: 'Inspect', submissionRequirements: policy}], edges: []};
  assert.deepEqual(toWorkflow(fromWorkflow(wire)).nodes[0].submissionRequirements, policy);
});

test('optional presentation bindings round-trip across unrelated workflow configurations', () => {
  const examples = [
    {
      id: 'calculation',
      name: 'Calculation',
      version: 4,
      nodes: [{
        id: 'calculate',
        kind: 'agent',
        name: 'Calculate',
        prompt: 'Calculate a result.',
        submissionRequirements: { complete: { fields: ['total'], minReferences: 0 } },
        presentationBindings: [
          { source: 'summary', label: 'Outcome' },
          { source: 'detail', field: 'total', label: 'Total', primary: true },
        ],
      }],
      edges: [],
    },
    {
      id: 'publishing',
      name: 'Publishing',
      nodes: [{
        id: 'publish',
        kind: 'agent',
        name: 'Prepare publication',
        prompt: 'Prepare a publication package.',
        submissionRequirements: { ready: { fields: ['audience'], minReferences: 0 } },
        presentationBindings: [{ source: 'artifact', label: 'Publication files', primary: true }],
      }],
      edges: [],
    },
  ];

  for (const wire of examples) {
    const encoded = toWorkflow(fromWorkflow(wire));
    assert.deepEqual(encoded.nodes[0].presentationBindings, wire.nodes[0].presentationBindings);
    if (wire.version) assert.equal(encoded.version, wire.version);
  }
});

test('legacy workflow definitions remain valid without presentation bindings', () => {
  const wire = { id: 'legacy', name: 'Legacy', nodes: [{ id: 'work', kind: 'agent', name: 'Work', prompt: 'Work.' }], edges: [] };
  const encoded = toWorkflow(fromWorkflow(wire));
  assert.equal('presentationBindings' in encoded.nodes[0], false);
  assert.deepEqual(validateWorkflow(fromWorkflow(wire)), []);
});

test('editor validation rejects undeclared detail fields and duplicate material bindings', () => {
  const graph = fromWorkflow({
    id: 'invalid-bindings',
    name: 'Invalid bindings',
    nodes: [{
      id: 'prepare',
      kind: 'agent',
      name: 'Prepare',
      prompt: 'Prepare output.',
      submissionRequirements: { ready: { fields: ['result'], minReferences: 0 } },
      presentationBindings: [
        { source: 'summary' },
        { source: 'summary', primary: true },
        { source: 'detail', field: 'typo' },
      ],
    }],
    edges: [],
  });
  const errors = validateWorkflow(graph).join(' ');
  assert.match(errors, /declared submission field/);
  assert.match(errors, /summary and artifact material can each be bound once/);
});

test('material binding authoring stays available until all distinct sources are used', () => {
  assert.equal(canAddPresentationBinding([{ source: 'summary' }], []), true);
  assert.equal(canAddPresentationBinding([{ source: 'artifact' }], []), true);
  assert.equal(canAddPresentationBinding([{ source: 'summary' }, { source: 'artifact' }], []), false);
  assert.equal(
    canAddPresentationBinding([{ source: 'summary' }, { source: 'artifact' }], ['result']),
    true,
  );
  assert.equal(canAddPresentationBinding(Array.from({ length: 12 }, () => ({ source: 'summary' })), ['result']), false);
});

test('editor validation rejects non-agent bindings and unsupported human outcomes', () => {
  const graph = fromWorkflow({
    id: 'unsupported-interaction',
    name: 'Unsupported interaction',
    entryNode: 'review',
    nodes: [
      {
        id: 'review',
        kind: 'human',
        name: 'Review',
        prompt: 'Review the result.',
        presentationBindings: [{ source: 'summary' }],
      },
      { id: 'done', kind: 'agent', name: 'Continue', prompt: 'Continue.' },
    ],
    edges: [{ id: 'custom', from: 'review', to: 'done', outcome: 'maybe' }],
  });
  const errors = validateWorkflow(graph).join(' ');
  assert.match(errors, /material bindings require an agent submission/);
  assert.match(errors, /human outcomes support approved and changes_requested only/);
});
