import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/chat/AgentRunBar.tsx', import.meta.url),
  'utf8',
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replace(
    /from '(react(?:\/jsx-runtime)?|lucide-react)'/g,
    (_, name) => `from '${import.meta.resolve(name)}'`,
  )
  .replace(
    /from "(react(?:\/jsx-runtime)?|lucide-react)"/g,
    (_, name) => `from '${import.meta.resolve(name)}'`,
  );
const { AgentRunBar } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

const session = {
  id: 'session',
  events: [],
  checks: [],
  workspace: { path: '/workspace', branch: 'convoy/change' },
};
function render(overrides = {}) {
  return renderToStaticMarkup(
    createElement(AgentRunBar, {
      session,
      state: { runners: [], environments: [] },
      tools: [],
      status: 'Ready',
      running: false,
      stopping: false,
      working: false,
      compact: true,
      showStatus: false,
      onStop() {},
      onReview() {},
      ...overrides,
    }),
  );
}

test('idle compact header omits status, Stop, and speculative Review', () => {
  const html = render();
  assert.doesNotMatch(html, /role="status"|aria-label="Stop"|aria-label="Review changes"/);
});

test('compact Review appears for recorded tracked or untracked changes', () => {
  for (const review of [
    { status: '', diff: 'diff --git a/file b/file', truncated: false },
    { status: '?? new-file', diff: '', truncated: false },
  ]) {
    assert.match(render({ session: { ...session, review } }), /aria-label="Review changes"/);
  }
  assert.doesNotMatch(
    render({
      session: {
        ...session,
        review: { status: ' \n', diff: '', truncated: false },
      },
    }),
    /aria-label="Review changes"/,
  );
});

test('active work offers Stop instead of Review and preserves accessible status', () => {
  const html = render({
    session: { ...session, review: { status: ' M file', diff: 'diff', truncated: false } },
    running: true,
    showStatus: true,
    status: 'Waiting for approval',
  });
  assert.match(html, /role="status" aria-label="Waiting for approval"/);
  assert.match(html, /aria-label="Stop"/);
  assert.doesNotMatch(html, /aria-label="Review changes"/);
  assert.match(render({ running: true, stopping: true }), /disabled="" aria-label="Stopping"/);
});

test('settings retain workspace inspection even before change evidence exists', () => {
  assert.match(render({ compact: false, showStatus: true }), /aria-label="Review changes"/);
});
