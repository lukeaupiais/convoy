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
const { fromWorkflow, toWorkflow, validateWorkflow, reorderWorkflowStages, insertWorkflowStage, workflowStageOrder } =
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
