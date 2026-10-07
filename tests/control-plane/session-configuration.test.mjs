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

test('working directory changes cannot leave active processes in a different execution context',()=>{
  const configuration=createSessionConfiguration({engine:{active:()=>false},execution:{},workflows:{},refreshInstructions(){},event(){},save:async()=>{}});
  for(const context of [{commands:[{state:'running'}]},{commands:[{state:'stopping'}]},{terminals:[{state:'running'}]},{assignment:{state:'uncertain'}},{skillSnapshots:[{snapshotId:'captured'}]}]){
    const session={workingDirectory:'first',...context};
    assert.throws(()=>configuration.plan(session,{workingDirectory:'second'}),/Stop or reconcile|already captured/);
    assert.equal(session.workingDirectory,'first');
  }
  assert.doesNotThrow(()=>configuration.plan({commands:[{state:'completed'}],terminals:[{state:'exited'}]},{workingDirectory:'second'}));
});
