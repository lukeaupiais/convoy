import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/workflows/workflow-runs.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  independentWorkflowRuns,
  workflowsForProject,
  workflowOverview,
  workflowForRun,
  currentWorkflowRunDetail,
  workflowRunCommandTarget,
  runControlEligibility,
  runAllowsContinue,
  runIsTerminal,
} = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const state = {
  projects: [
    {
      id: 'procurement',
      organizationId: 'org-a',
      teamId: 'finance',
      name: 'Procurement',
      revision: 1,
      description: '',
      executionProfile: 'default',
      placement: { mode: 'inherit' },
    },
    {
      id: 'publication',
      organizationId: 'org-b',
      teamId: 'editorial',
      name: 'Publication',
      revision: 1,
      description: '',
      executionProfile: 'default',
      placement: { mode: 'inherit' },
    },
  ],
  workflows: [
    {
      id: 'vendor-review',
      version: 3,
      organizationId: 'org-a',
      projectId: 'procurement',
      name: 'Vendor review',
      schemaVersion: 3,
      nodes: [{ id: 'quote', kind: 'human', name: 'Quote' }],
      edges: [],
      entryNode: 'quote',
      maxRevisions: 2,
      steps: [],
    },
    {
      id: 'content-review',
      version: 2,
      organizationId: 'org-b',
      teamId: 'editorial',
      name: 'Content review',
      schemaVersion: 3,
      nodes: [{ id: 'draft', kind: 'human', name: 'Draft' }],
      edges: [],
      entryNode: 'draft',
      maxRevisions: 2,
      steps: [],
    },
    {
      id: 'foreign',
      version: 1,
      organizationId: 'org-b',
      teamId: 'another-team',
      name: 'Unavailable graph',
      schemaVersion: 3,
      nodes: [],
      edges: [],
      entryNode: 'x',
      maxRevisions: 1,
      steps: [],
    },
  ],
  workflowRuns: [
    {
      id: 'run-quote',
      organizationId: 'org-a',
      projectId: 'procurement',
      independent: true,
      workflowId: 'vendor-review',
      workflowVersion: 3,
      status: 'waiting_gate',
      nodeId: 'quote',
      instance: 'quote-1',
      startedAt: '2026-10-01T00:00:00Z',
      history: [],
      lease: null,
    },
    {
      id: 'run-content',
      organizationId: 'org-b',
      projectId: 'publication',
      sessionId: 'agent-session',
      independent: true,
      workflowId: 'content-review',
      workflowVersion: 2,
      status: 'waiting_gate',
      nodeId: 'draft',
      instance: 'draft-1',
      startedAt: '2026-10-01T00:00:00Z',
      history: [],
      lease: null,
    },
    {
      id: 'legacy',
      organizationId: 'org-a',
      projectId: 'procurement',
      independent: false,
      workflowId: 'vendor-review',
      workflowVersion: 3,
      status: 'waiting_gate',
      startedAt: '2026-10-01T00:00:00Z',
      history: [],
      lease: null,
    },
  ],
};

test('the run surface filters by explicit independent identity and includes unrelated configured graphs', () => {
  assert.deepEqual(
    independentWorkflowRuns(state).map((run) => run.id),
    ['run-quote', 'run-content'],
  );
  assert.deepEqual(
    independentWorkflowRuns(state, 'procurement').map((run) => run.id),
    ['run-quote'],
  );
  assert.deepEqual(
    workflowsForProject(state, 'procurement').map((workflow) => workflow.id),
    ['vendor-review'],
  );
  assert.deepEqual(
    workflowsForProject(state, 'publication').map((workflow) => workflow.id),
    ['content-review'],
  );
  assert.equal(workflowForRun(state.workflowRuns[0], state.workflows).name, 'Vendor review');
  assert.equal(workflowForRun(state.workflowRuns[1], state.workflows).name, 'Content review');
  assert.equal(
    currentWorkflowRunDetail('run-content', state.workflowRuns[0], ['procurement']),
    null,
  );
  assert.equal(
    currentWorkflowRunDetail('run-content', state.workflowRuns[1], ['publication']).id,
    'run-content',
  );
  assert.equal(currentWorkflowRunDetail('legacy', state.workflowRuns[2], ['procurement']), null);
  assert.equal(
    workflowRunCommandTarget('run-content', state.workflowRuns[0], ['procurement']),
    null,
  );
  assert.deepEqual(
    workflowRunCommandTarget('run-content', state.workflowRuns[1], ['publication']),
    {
      workflowRunId: 'run-content',
      instance: 'draft-1',
    },
  );
});

test('run control display follows explicit lease ownership and terminal state', () => {
  const run = state.workflowRuns[0];
  run.lease = {
    id: 'lease-1',
    client: 'current-client',
    label: 'Web workflows',
    expiresAt: 2000,
    ownedByCurrentCaller: true,
  };
  assert.deepEqual(runControlEligibility(run, 1000), {
    ownsControl: true,
    canClaim: true,
    controlledElsewhere: false,
  });
  run.lease.ownedByCurrentCaller = false;
  assert.deepEqual(runControlEligibility(run, 1000), {
    ownsControl: false,
    canClaim: false,
    controlledElsewhere: true,
  });
  assert.equal(runControlEligibility(run, 2000).canClaim, true);
  assert.equal(runAllowsContinue('interrupted'), true);
  assert.equal(runAllowsContinue('waiting_gate'), false);
  assert.equal(runIsTerminal({ ...run, status: 'completed' }), true);
});

test('overview keeps definitions, drafts and latest runs inside the selected project', () => {
  const definition = (id, projectId, version) => ({
    id,
    projectId,
    organizationId: 'org',
    name: id,
    version,
  });
  const fixture = {
    projects: [
      { id: 'inventory', organizationId: 'org' },
      { id: 'publishing', organizationId: 'org' },
    ],
    workflows: [
      definition('restock', 'inventory', 1),
      definition('restock', 'inventory', 2),
      definition('release', 'publishing', 4),
    ],
    workflowDrafts: {
      draft: { workflow: definition('count', 'inventory', 0) },
      other: { workflow: definition('private', 'publishing', 0) },
    },
    workflowRuns: [
      {
        id: 'old',
        workflowId: 'restock',
        projectId: 'inventory',
        startedAt: '2026-10-01',
        status: 'completed',
      },
      {
        id: 'latest',
        workflowId: 'restock',
        projectId: 'inventory',
        startedAt: '2026-10-05',
        status: 'waiting_gate',
      },
      {
        id: 'foreign',
        workflowId: 'restock',
        projectId: 'publishing',
        startedAt: '2026-10-06',
        status: 'failed',
      },
    ],
  };
  const inventory = workflowOverview(fixture, 'inventory');
  assert.deepEqual(
    inventory.map((row) => row.workflow.id),
    ['count', 'restock'],
  );
  assert.equal(inventory[0].draft, true);
  assert.equal(inventory[1].workflow.version, 2);
  assert.equal(inventory[1].latestRun.id, 'latest');
  assert.deepEqual(
    workflowOverview(fixture, 'publishing').map((row) => row.workflow.id),
    ['private', 'release'],
  );
  assert.deepEqual(workflowOverview(fixture, 'missing'), []);
});
