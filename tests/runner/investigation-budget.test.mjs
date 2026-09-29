import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../packages/runner/src/agent-loop.mjs';
import { driveCommand } from '../../packages/runner/src/command-driver.mjs';

test('reserved rounds are signaled and cannot extend the hard cap', async () => {
  const budgets = [];
  let generations = 0;
  await assert.rejects(
    runAgentLoop({ maxRounds: 4, finalizationRounds: 2 }, async (method, value) => {
      if (method === 'prepare') budgets.push(value);
      if (method === 'generate') {
        generations++;
        return { content: [] };
      }
      if (method === 'afterRound') return false;
    }),
    /4 rounds/,
  );
  assert.equal(generations, 4);
  assert.deepEqual(
    budgets.map((b) => b.finalizing),
    [false, false, true, true],
  );
  assert.deepEqual(
    budgets.map((b) => b.round),
    [0, 1, 2, 3],
  );
});

test('bounded preview preserves both ends and links retained output without dropping progress', async () => {
  const output = 'START\n' + '😀'.repeat(12000) + '\nEND';
  const progress = [];
  const actions = [];
  const result = await driveCommand(
    async (request) => {
      actions.push(request.action);
      if (request.action === 'command_start') return { commandId: 'cmd-1' };
      if (request.action === 'command_poll')
        return {
          commandId: 'cmd-1',
          state: 'exited',
          cursor: Buffer.byteLength(output),
          chunks: [{ text: output }],
          hasMore: false,
          code: 0,
        };
    },
    { name: 'shell', args: { command: 'fixture' }, workspace: '/fixture' },
    async (value) => progress.push(value),
  );
  assert.equal(result.truncated, true);
  assert.match(result.output, /^START/);
  assert.match(result.output, /END$/);
  assert.deepEqual(result.outputRead, { commandId: 'cmd-1', cursor: 0 });
  assert.equal(progress[0].chunks[0].text, output);
  assert.equal(result.output.isWellFormed(), true);
  assert.ok(result.output.length < 12500);
  assert.equal(actions.at(-1), 'command_release');
});
