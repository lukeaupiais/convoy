import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/workflows/workflow-interaction.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(
  source.replace("import type { WorkflowEdge } from '../../shared/api/runtime';", ''),
  {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const {
  workflowActivityHistory,
  workflowDecisionCapabilities,
  workflowDecisionLabel,
  workflowNeedsRecovery,
  workflowRunOutput,
  workflowStatusLabel,
} = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('two unrelated workflow configurations render their own decision labels with generic defaults', () => {
  const inventory = {
    board: 'Warehouse North', workType: 'CycleCount', status: 'AwaitingRecount',
    review: { decisionLabels: { approved: 'Record estimate', changes_requested: 'Recalculate' } },
  };
  const editorial = {
    board: 'Quarterly Journal', workType: 'Essay', status: 'CopyDeskHold',
    review: { decisionLabels: { approved: 'Publish draft', changes_requested: 'Revise copy' } },
  };
  assert.equal(workflowDecisionLabel(inventory.review, 'approved'), 'Record estimate');
  assert.equal(workflowDecisionLabel(editorial.review, 'approved'), 'Publish draft');
  assert.equal(workflowDecisionLabel(inventory.review, 'changes_requested'), 'Recalculate');
  assert.equal(workflowDecisionLabel(editorial.review, 'changes_requested'), 'Revise copy');
  assert.equal(workflowDecisionLabel(undefined, 'approved'), 'Approve');
  assert.equal(workflowDecisionLabel(undefined, 'changes_requested'), 'Request changes');
});

test('workflow gate action capabilities depend on configured edges, independent of output materials', () => {
  const edges = [
    { id: 'approve', from: 'review', to: 'publish', outcome: 'approved' },
    { id: 'revise', from: 'review', to: 'draft', outcome: 'changes_requested' },
  ];
  assert.deepEqual(workflowDecisionCapabilities('review', edges), {
    approve: true,
    requestChanges: true,
  });
});

test('a gate resolves the exact source submission and bindings despite a newer latestSubmission', () => {
  const source = {
    nodeId: 'calculate',
    step: 'Calculate',
    summary: 'Exact reviewed result',
    revision: 4,
    artifacts: [],
  };
  const session = {
    activeTicketId: undefined,
    workflow: {
      nodes: [
        {
          id: 'calculate',
          kind: 'agent',
          presentationBindings: [{ source: 'summary', label: 'Result' }],
        },
        { id: 'review', kind: 'human' },
      ],
      edges: [],
    },
    flow: {
      status: 'waiting_gate',
      decisionSubmissionRef: { nodeId: 'calculate', instance: 'source-instance', revision: 4 },
      lastSubmission: {
        nodeId: 'other',
        step: 'Later output',
        summary: 'Must not replace the decision material',
        revision: 5,
        artifacts: [],
      },
      history: [
        {
          nodeId: 'calculate',
          instance: 'source-instance',
          outcome: 'success',
          submission: source,
        },
        {
          nodeId: 'other',
          instance: 'other-instance',
          outcome: 'success',
          submission: { nodeId: 'other', revision: 5, artifacts: [] },
        },
      ],
    },
  };
  const output = workflowRunOutput(session);
  assert.equal(output.submission, source);
  assert.equal(output.sourceNodeId, 'calculate');
  assert.deepEqual(output.bindings, [{ source: 'summary', label: 'Result' }]);
});

test('an unresolved exact reference fails closed instead of reusing a newer submission', () => {
  const session = {
    workflow: { nodes: [{ id: 'source', kind: 'agent' }], edges: [] },
    flow: {
      status: 'waiting_gate',
      decisionSubmissionRef: { nodeId: 'source', instance: 'missing-instance', revision: 1 },
      lastSubmission: { nodeId: 'source', step: 'Newer', summary: 'Not approved', artifacts: [] },
      history: [
        {
          nodeId: 'source',
          instance: 'other-instance',
          outcome: 'success',
          submission: { nodeId: 'source', revision: 2, artifacts: [] },
        },
      ],
    },
  };
  assert.equal(workflowRunOutput(session).submission, undefined);
});

test('approved output remains pinned while its configured reply effect is pending', () => {
  const reviewed = {
    nodeId: 'draft',
    instance: 'draft-instance',
    revision: 3,
    summary: 'Reviewed output',
    artifacts: [],
  };
  const session = {
    workflow: {
      nodes: [
        { id: 'draft', kind: 'agent' },
        { id: 'reply', kind: 'action', operation: 'send_external_reply' },
      ],
      edges: [],
    },
    flow: {
      status: 'waiting_event',
      nodeId: 'reply',
      approvedSubmission: {
        sourceSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 3 },
        submission: reviewed,
      },
      actionResult: { awaitingDelivery: true },
      lastSubmission: {
        nodeId: 'draft',
        summary: 'Newer but not approved',
        revision: 4,
        artifacts: [],
      },
      history: [
        { nodeId: 'draft', instance: 'draft-instance', outcome: 'success', submission: reviewed },
        {
          nodeId: 'review',
          instance: 'review-instance',
          outcome: 'approved',
          decisionSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 3 },
        },
      ],
    },
  };
  assert.equal(workflowRunOutput(session).submission, reviewed);
});

test('a later real activity output supersedes the completed reply effect source', () => {
  const later = { nodeId: 'verify', summary: 'Current verification', revision: 5, artifacts: [] };
  const session = {
    workflow: {
      nodes: [
        { id: 'draft', kind: 'agent' },
        { id: 'reply', kind: 'action', operation: 'send_external_reply' },
        { id: 'verify', kind: 'agent' },
      ],
      edges: [],
    },
    flow: {
      status: 'awaiting_continue',
      nodeId: 'verify',
      approvedSubmission: {
        sourceSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 3 },
        submission: { nodeId: 'draft', summary: 'Reviewed output', revision: 3, artifacts: [] },
      },
      lastSubmission: later,
      history: [
        {
          nodeId: 'draft',
          instance: 'draft-instance',
          outcome: 'success',
          submission: {
            nodeId: 'draft',
            instance: 'draft-instance',
            revision: 3,
            summary: 'Reviewed output',
            artifacts: [],
          },
        },
        {
          nodeId: 'review',
          instance: 'review-instance',
          outcome: 'approved',
          decisionSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 3 },
        },
        { nodeId: 'verify', instance: 'verify-instance', outcome: 'success', submission: later },
      ],
    },
  };
  assert.equal(workflowRunOutput(session).submission, later);
});

test('approved output stays visible through generic downstream actions until new activity output', () => {
  const reviewed = {
    nodeId: 'plan',
    instance: 'plan-instance',
    revision: 2,
    summary: 'Reviewed plan',
    artifacts: [],
  };
  const gate = {
    nodeId: 'review',
    instance: 'review-instance',
    outcome: 'approved',
    decisionSubmissionRef: { nodeId: 'plan', instance: 'plan-instance', revision: 2 },
  };
  const base = {
    workflow: {
      nodes: [
        { id: 'plan', kind: 'agent' },
        { id: 'review', kind: 'human' },
        { id: 'check', kind: 'check' },
      ],
      edges: [],
    },
    flow: {
      status: 'waiting_event',
      nodeId: 'check',
      lastSubmission: reviewed,
      history: [
        { nodeId: 'plan', instance: 'plan-instance', outcome: 'success', submission: reviewed },
        gate,
        { nodeId: 'check', instance: 'check-instance', outcome: 'success' },
      ],
    },
  };
  assert.equal(workflowRunOutput(base).submission, reviewed);
  const newer = {
    nodeId: 'verify',
    instance: 'verify-instance',
    revision: 3,
    summary: 'New result',
    artifacts: [],
  };
  const later = {
    ...base,
    workflow: {
      ...base.workflow,
      nodes: [...base.workflow.nodes, { id: 'verify', kind: 'agent' }],
    },
    flow: {
      ...base.flow,
      status: 'awaiting_continue',
      nodeId: 'verify',
      lastSubmission: newer,
      history: [
        ...base.flow.history,
        { nodeId: 'verify', instance: 'verify-instance', outcome: 'success', submission: newer },
      ],
    },
  };
  assert.equal(workflowRunOutput(later).submission, newer);
});

test('a non-agent check summary does not replace the approved captured output', () => {
  const reviewed = {
    nodeId: 'plan',
    instance: 'plan-instance',
    revision: 2,
    summary: 'Reviewed plan',
    artifacts: [],
  };
  const checkSummary = {
    nodeId: 'check',
    instance: 'check-instance',
    revision: 3,
    summary: 'Check completed',
    artifacts: [],
  };
  const session = {
    workflow: {
      nodes: [
        { id: 'plan', kind: 'agent' },
        { id: 'review', kind: 'human' },
        { id: 'check', kind: 'check' },
      ],
      edges: [],
    },
    flow: {
      status: 'completed',
      nodeId: null,
      lastSubmission: checkSummary,
      history: [
        { nodeId: 'plan', instance: 'plan-instance', outcome: 'success', submission: reviewed },
        {
          nodeId: 'review',
          instance: 'review-instance',
          outcome: 'approved',
          decisionSubmissionRef: { nodeId: 'plan', instance: 'plan-instance', revision: 2 },
        },
        {
          nodeId: 'check',
          instance: 'check-instance',
          outcome: 'success',
          submission: checkSummary,
        },
      ],
    },
  };
  assert.equal(workflowRunOutput(session).submission, reviewed);
});

test('a later gate source replaces an older retained approved reply source', () => {
  const older = {
    nodeId: 'draft',
    instance: 'draft-instance',
    revision: 1,
    summary: 'Old draft',
    artifacts: [],
  };
  const newer = {
    nodeId: 'estimate',
    instance: 'estimate-instance',
    revision: 2,
    summary: 'New gate source',
    artifacts: [],
  };
  const session = {
    workflow: {
      nodes: [{ id: 'draft' }, { id: 'review-one' }, { id: 'estimate' }, { id: 'review-two' }],
      edges: [],
    },
    flow: {
      status: 'waiting_gate',
      nodeId: 'review-two',
      decisionSubmissionRef: { nodeId: 'estimate', instance: 'estimate-instance', revision: 2 },
      approvedSubmission: {
        reviewNodeId: 'review-one',
        reviewInstance: 'review-one-instance',
        sourceSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 1 },
        submission: older,
      },
      lastSubmission: newer,
      history: [
        { nodeId: 'draft', instance: 'draft-instance', outcome: 'success', submission: older },
        {
          nodeId: 'review-one',
          instance: 'review-one-instance',
          outcome: 'approved',
          decisionSubmissionRef: { nodeId: 'draft', instance: 'draft-instance', revision: 1 },
        },
        {
          nodeId: 'estimate',
          instance: 'estimate-instance',
          outcome: 'success',
          submission: newer,
        },
      ],
    },
  };
  assert.equal(workflowRunOutput(session).submission, newer);
});

test('legacy paused approved content remains readable when its exact captured copy exists', () => {
  const approved = {
    nodeId: 'draft',
    instance: 'draft-instance',
    step: 'Draft',
    revision: 3,
    summary: 'Approved copy',
    artifacts: [],
  };
  const session = {
    workflow: { nodes: [{ id: 'draft' }], edges: [] },
    flow: { status: 'paused', approvedSubmission: { submission: approved }, history: [] },
  };
  assert.equal(workflowRunOutput(session).submission, approved);
});

test('runs without a ticket and without output retain an empty neutral result surface', () => {
  const session = {
    workflow: { nodes: [{ id: 'calculate', kind: 'check' }], edges: [] },
    flow: { status: 'completed', nodeId: null, history: [] },
  };
  assert.deepEqual(workflowRunOutput(session), {
    submission: undefined,
    sourceNodeId: undefined,
    bindings: [],
  });
});

test('known engine states use concise operator labels with readable generic fallback', () => {
  assert.equal(workflowStatusLabel('waiting_gate'), 'Decision required');
  assert.equal(workflowStatusLabel('waiting_event'), 'Waiting for event');
  assert.equal(workflowStatusLabel('awaiting_continue'), 'Ready to continue');
  assert.equal(workflowStatusLabel('awaiting_submission'), 'Output required');
  assert.equal(workflowStatusLabel('paused_by_adapter'), 'Paused by adapter');
});

test('activity history is a concise projection of configured names, outcomes, and recorded times', () => {
  const session = {
    workflow: { nodes: [{ id: 'draft', name: 'Prepare draft' }] },
    flow: {
      history: [
        {
          nodeId: 'draft',
          outcome: 'success',
          at: '2026-09-30T12:00:00.000Z',
          submission: { summary: 'Private body is not part of history' },
        },
        { nodeId: 'removed-node', outcome: 'failed' },
      ],
    },
  };
  assert.deepEqual(workflowActivityHistory(session), [
    { nodeName: 'Prepare draft', outcome: 'success', at: '2026-09-30T12:00:00.000Z' },
    { nodeName: 'removed-node', outcome: 'failed', at: undefined },
  ]);
  assert.deepEqual(workflowActivityHistory({ flow: { history: [] } }), []);
});

test('recovery affordance is limited to blocked runs and uncertain execution or delivery', () => {
  assert.equal(workflowNeedsRecovery({ flow: { status: 'failed' } }), true);
  assert.equal(workflowNeedsRecovery({ assignment: { state: 'uncertain' } }), true);
  assert.equal(
    workflowNeedsRecovery({
      flow: { status: 'waiting_event', actionResult: { deliveryStatus: 'unknown' } },
    }),
    true,
  );
  assert.equal(workflowNeedsRecovery({ flow: { status: 'running' } }), false);
});

test('custom human outcomes do not get presented as generic approval', () => {
  const customOnly = [{ id: 'publish', from: 'review', to: 'done', outcome: 'publish' }];
  assert.deepEqual(workflowDecisionCapabilities('review', customOnly), {
    approve: false,
    requestChanges: false,
  });
  assert.deepEqual(workflowDecisionCapabilities('terminal-review', []), {
    approve: true,
    requestChanges: false,
  });
});

test('approval is unavailable when an exact pinned decision submission cannot be resolved', () => {
  assert.deepEqual(
    workflowDecisionCapabilities(
      'review',
      [{ id: 'approve', from: 'review', to: 'finish', outcome: 'approved' }],
      { required: true, available: false },
    ),
    { approve: false, requestChanges: false },
  );
});

test('legacy string paths remain uncaptured paths and never become viewer content', () => {
  const session = {
    workflow: { nodes: [{ id: 'source', kind: 'agent' }], edges: [] },
    flow: {
      status: 'awaiting_continue',
      nodeId: 'source',
      lastSubmission: { nodeId: 'source', summary: 'Legacy output', artifacts: ['reports/old.md'] },
    },
  };
  const output = workflowRunOutput(session);
  assert.deepEqual(
    output.submission.artifacts.filter((item) => typeof item === 'string'),
    ['reports/old.md'],
  );
});

test('workflow fallback decisions match exact supported outcomes before wildcard/default', () => {
  assert.deepEqual(
    workflowDecisionCapabilities('review', [
      { id: 'default', from: 'review', to: 'fallback', outcome: 'default' },
      { id: 'custom', from: 'review', to: 'custom', outcome: 'publish' },
    ]),
    { approve: true, requestChanges: true },
  );
});
