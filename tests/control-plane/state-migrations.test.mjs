import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { migrateAgentState } from '../../apps/daemon/src/modules/agents/index.mjs';
import { migrateLibraryState } from '../../apps/daemon/src/modules/library/index.mjs';
import { migrateWorkflowState } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/default-workflow.mjs';
import { migrateWorkflowEffectState } from '../../apps/daemon/src/control-plane/workflow-effects.mjs';

test('owner migrations upgrade a legacy state additively without creating an implicit workflow', () => {
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
  assert.deepEqual(state.workflows, []);
  assert.deepEqual(state.defaultWorkflowIds, { organizations: {}, projects: {} });
});

test('workflow migration preserves an explicit legacy default and its immutable workflow bytes', () => {
  const legacyDefault = structuredClone(defaultWorkflowDefinition);
  legacyDefault.version = undefined;
  const legacy = { id: 'legacy', name: 'Legacy', nodes: [{ id: 'one', kind: 'human', name: 'One', prompt: 'Review' }], edges: [], entryNode: 'one' };
  const state = { workflows: [legacyDefault, legacy], defaultWorkflowId: 'delivery', workflowDrafts: {} };
  const rawDefinitions = structuredClone(state.workflows);
  migrateWorkflowState(state, { defaultWorkflow: defaultWorkflowDefinition, normalize: (value) => value });
  assert.deepEqual(state.workflows, rawDefinitions);
  assert.equal(state.defaultWorkflowId, 'delivery', 'the stored legacy default pointer remains unchanged');
  assert.equal(state.defaultWorkflowIds.organizations.personal, 'delivery');
  assert.deepEqual(state.defaultWorkflowIds.projects, {});
  const once = structuredClone(state);
  migrateWorkflowState(state, { defaultWorkflow: defaultWorkflowDefinition, normalize: (value) => value });
  assert.deepEqual(state, once, 'restarting does not rewrite configured published definitions');
});
