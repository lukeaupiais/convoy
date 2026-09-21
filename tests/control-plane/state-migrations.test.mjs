import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { migrateAgentState } from '../../apps/daemon/src/modules/agents/index.mjs';
import { migrateLibraryState } from '../../apps/daemon/src/modules/library/index.mjs';
import { migrateWorkflowState } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/default-workflow.mjs';
import { migrateWorkflowEffectState } from '../../apps/daemon/src/control-plane/workflow-effects.mjs';

test('owner migrations upgrade a legacy state additively and remain idempotent', () => {
  const workflow = { id: 'default', name: 'Default', nodes: [{ id: 'one', kind: 'agent', name: 'One', prompt: 'Go' }] };
  const state = { sessions: { legacy: {} }, projects: [], runners: [] };
  migrateControlPlaneState(state);
  migrateAgentState(state);
  migrateLibraryState(state);
  migrateWorkflowState(state, { defaultWorkflow: workflow, normalize: (value) => value });
  migrateWorkflowEffectState(state);
  const once = structuredClone(state);
  migrateControlPlaneState(state);
  migrateAgentState(state);
  migrateLibraryState(state);
  migrateWorkflowState(state, { defaultWorkflow: workflow, normalize: (value) => value });
  migrateWorkflowEffectState(state);
  assert.deepEqual(state, once);
  assert.deepEqual(state.sessions.legacy.capabilityProfile, null);
  assert.deepEqual(state.workflowEffectLedger, {});
  assert.equal(state.workflows[0].id, 'default');
});

test('workflow migration adds the team delivery template without replacing published workflows', () => {
  const state = {
    workflows: [{ id: 'legacy', name: 'Legacy', nodes: [{ id: 'one', kind: 'human', name: 'One', prompt: 'Review' }], edges: [], entryNode: 'one' }],
    workflowDrafts: {},
  };
  migrateWorkflowState(state, { defaultWorkflow: defaultWorkflowDefinition, normalize: (value) => value });
  assert.deepEqual(state.workflows.map((workflow) => workflow.id), ['legacy', 'delivery']);
});
