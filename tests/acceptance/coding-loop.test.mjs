import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import { digest, executeRunner, processRun } from '../../packages/runner/src/index.mjs';

const reply = content => ({ role: 'assistant', content, stopReason: 'stop', timestamp: Date.now() });
const call = (id, name, arguments_) => reply([{ type: 'toolCall', id, name, arguments: arguments_ }]);

async function until(read) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Acceptance condition did not become true.');
}

test('acceptance: a local coding turn reads, patches, tests, streams and exposes its diff', async t => {
  const repository = await mkdtemp(join(tmpdir(), 'convoy-coding-repository-'));
  assert.equal((await processRun('git', ['init', repository])).code, 0);
  const original = "export const message = 'before';\n";
  await writeFile(join(repository, 'value.mjs'), original);
  await writeFile(join(repository, 'verify.mjs'), "import { message } from './value.mjs';\nif (message !== 'after') process.exit(1);\nconsole.log(message);\n");
  await processRun('git', ['add', 'value.mjs', 'verify.mjs'], { cwd: repository });
  assert.equal((await processRun('git', ['-c', 'user.name=Convoy Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repository })).code, 0);

  const probe = await executeRunner({ action: 'probe', repository });
  if (!probe.shell) return t.skip('bubblewrap sandbox is unavailable in this environment.');

  const runners = createRunners();
  const directory = await mkdtemp(join(tmpdir(), 'convoy-coding-coordinator-'));
  let round = 0;
  const runtime = await createRuntime({
    directory,
    runners,
    models: [{ id: 'fixture-model' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {
      round++;
      if (round === 1) yield { type: 'result', message: call('read', 'read_file', { path: 'value.mjs' }) };
      else if (round === 2) yield { type: 'result', message: call('patch', 'apply_patch', { path: 'value.mjs', expectedHash: digest(original), edits: [{ oldText: "'before'", newText: "'after'" }] }) };
      else if (round === 3) yield { type: 'result', message: call('test', 'shell', { command: 'node verify.mjs' }) };
      else {
        yield { type: 'delta', text: 'Change verified' };
        yield { type: 'result', message: reply([{ type: 'text', text: 'Change verified.' }]) };
      }
    },
  });
  t.after(async () => { await runtime.close(); await runners.close(); });

  let streamed = false;
  runtime.subscribe(change => { if (change.type === 'partial' && change.text === 'Change verified') streamed = true; });
  const command = (action, input = {}) => runtime.command({ action, client: 'coding-acceptance', ...input });
  const runner = await command('registerRunner', { name: 'Local fixture', kind: 'local', repository });
  const conversation = await command('createConversation', { requestId: 'coding-loop', projectId: 'agent-platform', placement: { mode: 'pinned', runnerId: runner.id } });
  const sessionId = conversation.sessionId;
  const session = async () => (await runtime.snapshot(sessionId)).sessions[0];
  await command('claim', { sessionId, label: 'Acceptance' });
  await command('start', { sessionId, model: 'fixture-model', text: 'Change the value and verify it.', requestId: 'coding-turn' });

  for (const tool of ['apply_patch', 'shell']) {
    const pending = await until(async () => {
      const current = await session();
      if (current.status === 'failed') throw new Error(JSON.stringify(current.events.slice(-5)));
      return current.pending?.tool === tool ? current.pending : null;
    });
    await command('decide', { sessionId, approvalId: pending.id, decision: 'allow_once' });
  }

  const completed = await until(async () => {
    const current = await session();
    return !current.control.busy && current.status === 'awaiting_review' ? current : null;
  });
  await command('diff', { sessionId });
  const review = (await session()).review;
  assert.equal(await readFile(join(repository, 'value.mjs'), 'utf8'), original);
  assert.equal(await readFile(join(completed.workspace.path, 'value.mjs'), 'utf8'), "export const message = 'after';\n");
  assert.match(review.diff, /before/);
  assert.match(review.diff, /after/);
  assert.equal(completed.checks.at(-1).code, 0);
  assert.equal(completed.checks.at(-1).output, 'after\n');
  assert.ok(streamed);
  assert.deepEqual(completed.events.filter(event => event.type === 'tool_result').map(event => event.tool), ['read_file', 'apply_patch', 'shell']);
});
