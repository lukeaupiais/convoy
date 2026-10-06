import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function compile(file) {
  return ts.transpileModule(
    await readFile(
      new URL(`../../apps/web/src/features/sessions/${file}`, import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
}
const url = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compiled = (await compile('attention.ts')).replace(
  "from './sessionMonitor'",
  `from '${url(await compile('sessionMonitor.ts'))}'`,
);
const { attentionItems } = await import(url(compiled));
const session = (id, status) => ({
  id,
  title: id,
  status,
  events: [],
  updatedAt: '2026-10-05T12:00:00Z',
});
const state = (extra = {}) => ({
  sessions: [],
  tickets: [],
  workflows: [],
  workflowRuns: [],
  ...extra,
});

test('attention excludes ordinary progress and completed replies and persists until resolved', () => {
  const snapshot = state({
    sessions: [
      session('working', 'running'),
      session('queued', 'queued'),
      { ...session('reply', 'awaiting_review'), events: [{ type: 'assistant' }] },
      { ...session('question', 'waiting_question'), conversationId: 'chat-question' },
    ],
  });
  assert.deepEqual(
    attentionItems(snapshot).map((item) => item.target),
    [{ kind: 'conversation', id: 'chat-question' }],
  );
  assert.equal(attentionItems(snapshot).length, 1);
  snapshot.sessions[3].status = 'running';
  assert.equal(attentionItems(snapshot).length, 0);
});

test('independent decisions and sessionless failures have direct targets and no duplicate effects', () => {
  const snapshot = state({
    workflows: [{ id: 'audit', version: 4, name: 'Document audit' }],
    workflowRuns: [
      {
        id: 'review',
        independent: true,
        workflowId: 'audit',
        workflowVersion: 4,
        status: 'waiting_gate',
      },
      {
        id: 'uncertain',
        independent: true,
        workflowId: 'audit',
        workflowVersion: 4,
        status: 'failed',
      },
      { id: 'done', independent: true, status: 'completed' },
      {
        id: 'ineligible',
        independent: true,
        status: 'waiting_gate',
        humanTaskReviewerEligible: false,
      },
    ],
    tickets: [{ id: 42, title: 'Inventory import', projectId: 'warehouse' }],
    automationDecisions: [{ triggerKey: 'start-import', ticketId: 42, status: 'failed' }],
    workflowEffects: [
      { effectKey: 'uncertain:one:node', status: 'uncertain', operation: 'write_file' },
    ],
  });
  const items = attentionItems(snapshot);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.target),
    [
      { kind: 'workflow', id: 'review' },
      { kind: 'workflow', id: 'uncertain' },
      { kind: 'ticket', id: 42 },
    ],
  );
  assert.equal(items[0].title, 'Document audit');
  assert.equal(items[1].status, 'Outcome uncertain');
});

test('a workflow represented by a conversation produces a single attention item', () => {
  const snapshot = state({
    sessions: [
      {
        ...session('agent', 'waiting_gate'),
        conversationId: 'conversation',
        flow: { id: 'run', instance: 'one' },
      },
    ],
    workflowRuns: [{ id: 'run', independent: true, status: 'waiting_gate' }],
    workflowEffects: [{ effectKey: 'run:one:node', status: 'uncertain', operation: 'write_file' }],
  });
  assert.equal(attentionItems(snapshot).length, 1);
  assert.deepEqual(attentionItems(snapshot)[0].target, {
    kind: 'conversation',
    id: 'conversation',
  });
});
