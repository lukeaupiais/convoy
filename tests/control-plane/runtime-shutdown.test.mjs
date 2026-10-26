import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-runtime-shutdown-'));
  const persistence = await createPersistence({ directory, initialState: initialControlPlaneState() });
  const entered = deferred();
  const release = deferred();
  const gateFinished = deferred();
  let block;
  let consumed = false;
  let closed = false;
  let lateWrites = 0;
  persistence.store.save = async () => {
    if (closed) lateWrites++;
    if (!consumed && block && await block()) {
      consumed = true;
      entered.resolve();
      await release.promise;
      if (closed) lateWrites++;
      gateFinished.resolve();
    }
  };
  persistence.store.close = async () => { closed = true; };
  const runtime = await createRuntime({ persistence, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {
      yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], stopReason: 'stop', timestamp: Date.now() } };
    },
  });
  t.after(async () => {
    release.resolve();
    if (consumed) await gateFinished.promise;
    await runtime.close();
    await new Promise(resolve => setImmediate(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, persistence, entered, release, setBlock(value) { block = value; }, lateWrites: () => lateWrites };
}

async function assertCloseWaits(f) {
  let finished = false;
  const closing = f.runtime.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'shutdown must wait for admitted work and its final writes');
  f.release.resolve();
  await closing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.lateWrites(), 0, 'no admitted work may save after storage closes');
}

test('shutdown drains an admitted command before its final save and storage close', async t => {
  const f = await fixture(t);
  f.setBlock(() => true);
  const command = f.runtime.command({ action: 'saveProject', client: 'shutdown-test', name: 'Drain accepted command' });
  await f.entered.promise;
  await assertCloseWaits(f);
  await command;
});

test('shutdown retains a job through cleanup after its capacity slot is released', async t => {
  const f = await fixture(t);
  const client = 'shutdown-test';
  const chat = await f.runtime.command({ action: 'createConversation', client, projectId: 'agent-platform', requestId: 'shutdown-chat' });
  const taskId = chat.sessionId;
  await f.runtime.command({ action: 'claim', client, taskId, label: 'Shutdown test' });
  f.setBlock(async () => {
    if (!f.persistence.store.data.sessions[taskId].events.some(event => event.type === 'assistant')) return false;
    const state = await f.runtime.snapshot(taskId, client);
    return state.sessions[0].control.busy === false;
  });
  await f.runtime.command({ action: 'sendMessage', client, taskId, text: 'Finish this turn', model: 'fixture', mode: 'queue', requestId: 'shutdown-message' });
  await f.entered.promise;
  await assertCloseWaits(f);
});

test('shutdown drains admitted stop commands that bypass the serial queue', async t => {
  const f = await fixture(t);
  const client = 'shutdown-test';
  const chat = await f.runtime.command({ action: 'createConversation', client, projectId: 'agent-platform', requestId: 'shutdown-stop-chat' });
  await f.runtime.command({ action: 'claim', client, taskId: chat.sessionId, label: 'Shutdown test' });
  f.setBlock(() => true);
  const stop = f.runtime.command({ action: 'stop', client, taskId: chat.sessionId });
  await f.entered.promise;
  await assertCloseWaits(f);
  await stop;
});

test('commands rejected after shutdown cannot append audit or persistence writes', async t => {
  const f = await fixture(t);
  await f.runtime.close();
  await assert.rejects(f.runtime.command({ action: 'saveProject', client: 'shutdown-test', name: 'Too late' }), /shutting down/);
  assert.equal(f.lateWrites(), 0);
});


test('workflow event admission is rejected after shutdown without persistence writes', async t => {
  const f = await fixture(t);
  await f.runtime.close();
  await assert.rejects(f.runtime.tickWorkflowEvents(), /shutting down/);
  await assert.rejects(f.runtime.receiveWorkflowWebhook('closed-binding', {}, undefined), /shutting down/);
  assert.equal(f.lateWrites(), 0);
});
