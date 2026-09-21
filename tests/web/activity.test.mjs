import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
// Exercise the browser's pure module without requiring Node's experimental TS loader.
const source = await readFile(
  new URL('../../apps/web/src/features/chat/activity.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildTimeline, lineDiff, toolGroupLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const e = (seq, type, rest = {}) => ({ seq, type, at: 'now', agentSessionId: 'main', ...rest });
const session = { status: 'awaiting_review', pending: null, control: { busy: false } };
test('activity groups calls between messages, correlates denial and keeps identities separate', () => {
  const events = [
    e(1, 'user', { text: 'Go' }),
    e(2, 'tool_requested', { callId: 'a', tool: 'shell', args: { command: 'npm test' } }),
    e(3, 'approval_requested', {
      approval: { id: 'approve', callId: 'a', tool: 'shell', args: { command: 'npm test' } },
    }),
    e(4, 'approval_decision', { approvalId: 'approve', allow: false }),
    e(5, 'tool_result', { callId: 'a', tool: 'shell', isError: true, output: { error: 'Denied' } }),
    e(6, 'assistant', { text: 'Not run' }),
    e(7, 'tool_requested', {
      agentSessionId: 'other',
      callId: 'a',
      tool: 'read_file',
      args: { path: 'x' },
    }),
    e(8, 'tool_result', {
      agentSessionId: 'other',
      callId: 'a',
      tool: 'read_file',
      output: { text: 'OK' },
    }),
  ];
  const groups = buildTimeline(events, session).filter((i) => i.kind === 'tools');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].tools[0].status, 'denied');
  assert.equal(groups[1].tools[0].status, 'succeeded');
});
test('pending approval remains visible with truncated history and is bound to its exact ID', () => {
  const rows = buildTimeline([], {
    ...session,
    status: 'waiting_approval',
    pending: {
      id: 'live',
      callId: 'call',
      tool: 'write_file',
      args: { path: 'x', content: 'safe' },
    },
  });
  assert.equal(rows[0].tools[0].approvalId, 'live');
  assert.equal(rows[0].tools[0].status, 'approval');
});

test('legacy approvals without call IDs join their recorded result instead of appearing falsely stopped', () => {
  const rows = buildTimeline(
    [
      e(1, 'approval_requested', {
        approval: { id: 'old', tool: 'shell', args: { command: 'true' } },
      }),
      e(2, 'approval_decision', { approvalId: 'old', allow: true }),
      e(3, 'tool_started', { callId: 'call', tool: 'shell' }),
      e(4, 'tool_result', { callId: 'call', tool: 'shell', output: { code: 0 } }),
    ],
    session,
  );
  assert.equal(rows[0].tools.length, 1);
  assert.equal(rows[0].tools[0].status, 'succeeded');
});
test('write diff uses only a hash-matching read snapshot; unmatched writes have no fabricated old contents', () => {
  const events = [
    e(1, 'tool_requested', { callId: 'r', tool: 'read_file', args: { path: 'x' } }),
    e(2, 'tool_result', {
      callId: 'r',
      tool: 'read_file',
      output: { text: 'old', sha256: 'hash' },
    }),
    e(3, 'tool_requested', {
      callId: 'w',
      tool: 'write_file',
      args: { path: 'x', content: 'new', expectedHash: 'hash' },
    }),
    e(4, 'tool_requested', {
      callId: 'p',
      tool: 'apply_patch',
      args: { path: 'x', expectedHash: 'hash', edits: [{ oldText: 'old', newText: 'new' }] },
    }),
    e(5, 'tool_requested', {
      callId: 'w2',
      tool: 'write_file',
      args: { path: 'x', content: 'different', expectedHash: 'other' },
    }),
  ];
  const tools = buildTimeline(events, session)[0].tools;
  assert.equal(tools[1].before, 'old');
  assert.equal(tools[2].before, 'old');
  assert.equal(tools[3].before, undefined);
  assert.deepEqual(lineDiff('old', 'new'), [
    { kind: 'remove', text: 'old' },
    { kind: 'add', text: 'new' },
  ]);
});
test('operation summaries foreground active approvals and compact completed work', () => {
  assert.equal(
    toolGroupLabel([
      { tool: 'apply_patch', args: { path: 'src/a.ts', edits: [{}, {}] }, status: 'approval' },
    ]),
    'Approval needed · Patch file',
  );
  assert.equal(
    toolGroupLabel([
      { tool: 'read_file', args: { path: 'a' }, status: 'succeeded' },
      { tool: 'shell', args: { command: 'npm test' }, status: 'failed' },
    ]),
    '2 operations · 1 needs attention',
  );
});
