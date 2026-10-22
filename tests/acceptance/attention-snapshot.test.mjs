import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const compile = async file => ts.transpileModule(
  await readFile(new URL(`../../apps/web/src/features/sessions/${file}`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const attentionSource = (await compile('attention.ts')).replace("from './sessionMonitor'", `from '${url(await compile('sessionMonitor.ts'))}'`);
const { attentionItems } = await import(url(attentionSource));

test('compact attention snapshots preserve real workflow decisions and conversation targets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-attention-'));
  const runtime = await createRuntime({ directory, models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: false }) },
    generate: async function* () { throw new Error('Attention reads must never execute an agent'); },
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const act = (action, input) => runtime.command({ action, client: 'attention-test', ...input });
  await act('createConversation', { projectId: 'agent-platform', title: 'Editorial discussion', requestId: 'discussion' });
  await act('saveWorkflow', { workflow: { id: 'review', name: 'Supplier review', nodes: [{ id: 'decision', name: 'Review supplier', kind: 'human' }] } });
  await act('startWorkflowRun', { projectId: 'agent-platform', workflowId: 'review', workflowVersion: 1 });
  const full = await runtime.snapshot(undefined, 'attention-test');
  const compact = await runtime.snapshot(undefined, 'attention-test', undefined, { view: 'attention' });
  assert.ok(attentionItems(full).some(item => item.target.kind === 'workflow'), 'the fixture contains a real human decision');
  assert.deepEqual(attentionItems(compact), attentionItems(full));
  assert.equal(compact.sessionDetailsIncluded, false);
  assert.ok(compact.sessions.length > 0, 'conversation status summaries remain available');
  assert.ok(compact.sessions.every(session => session.events.length === 0 && !session.commands));
});
