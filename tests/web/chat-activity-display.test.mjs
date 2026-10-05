import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function compile(file) {
  return ts.transpileModule(
    await readFile(new URL(`../../apps/web/src/features/chat/${file}`, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
}
const activity = dataUrl(await compile('activity.ts'));
const runtime = dataUrl(
  'export const owns = () => true; export const command = () => { throw new Error("Unexpected command"); };',
);
const compiled = (await compile('ToolActivity.tsx'))
  .replace(/import '\.\/tool-activity\.css';/, '')
  .replace(
    /from '(react(?:\/jsx-runtime)?|lucide-react)'/g,
    (_, name) => `from '${import.meta.resolve(name)}'`,
  )
  .replace(
    /from "(react(?:\/jsx-runtime)?|lucide-react)"/g,
    (_, name) => `from '${import.meta.resolve(name)}'`,
  )
  .replace("from './activity'", `from '${activity}'`)
  .replace("from '../../shared/api/runtime'", `from '${runtime}'`);
const { ToolGroup } = await import(dataUrl(compiled));
const tool = (status, path) => ({ key: path, seq: 1, tool: 'read_file', args: { path }, status });
function render(tools, session = {}) {
  return renderToStaticMarkup(
    createElement(ToolGroup, { tools, session, working: false, act() {} }),
  );
}

test('completed operations stay collapsed while failures remain visible', () => {
  const html = render([tool('succeeded', 'successful.txt'), tool('failed', 'failed.txt')]);
  assert.doesNotMatch(html, /successful\.txt/);
  assert.match(html, /failed\.txt/);
  assert.match(html, /aria-expanded="false"/);
});

test('approval and running operations remain visible alongside collapsed successes', () => {
  const html = render([
    tool('succeeded', 'successful.txt'),
    tool('approval', 'approval.txt'),
    tool('running', 'running.txt'),
  ]);
  assert.doesNotMatch(html, /successful\.txt/);
  assert.match(html, /approval\.txt/);
  assert.match(html, /running\.txt/);
});

test('lost commands remain visible even if the tool has already returned successfully', () => {
  const html = render(
    [{ ...tool('succeeded', 'lost.txt'), callId: 'command', agentSessionId: 'agent' }],
    {
      commands: [{ callId: 'command', agentSessionId: 'agent', state: 'lost' }],
    },
  );
  assert.match(html, /lost\.txt/);
  assert.match(html, /Failed/);
});
