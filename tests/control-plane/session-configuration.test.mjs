import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionConfiguration } from '../../apps/daemon/src/control-plane/session-configuration.mjs';

test('configuration validates every owner selection before provisioning a workspace', async () => {
  let prepared = false;
  const configuration = createSessionConfiguration({
    engine: { active: () => false },
    execution: {
      runnerSelection: () => ({ placement: { mode: 'pinned', runnerId: 'runner' } }),
      async prepare(session) { prepared = true; session.workspace = { path: '/work' }; return {}; },
      async release() {},
    },
    workflows: { selection: () => { throw new Error('Workflow not found.'); } },
    refreshInstructions() {}, event() {}, save: async () => {},
  });
  await assert.rejects(
    configuration.apply({ pendingMessages: [], instructions: [] }, { runnerId: 'runner', workflow: 'gone' }),
    /Workflow not found/,
  );
  assert.equal(prepared, false);
});

test('configuration rejects runner selection before it changes session placement', async () => {
  const session = { pendingMessages: [], instructions: [], placement: { mode: 'none' } };
  const configuration = createSessionConfiguration({
    engine: { active: () => false },
    execution: { runnerSelection: () => { throw new Error('Runner is disabled.'); } },
    workflows: { selection: () => ({ id: 'unused' }) },
    refreshInstructions() {}, event() {}, save: async () => {},
  });
  await assert.rejects(configuration.apply(session, { runnerId: 'blocked' }), /disabled/);
  assert.deepEqual(session.placement, { mode: 'none' });
});
