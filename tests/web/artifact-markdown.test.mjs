import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/tickets/artifact-markdown.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { artifactMarkdownBlocks } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('artifact Markdown presents plans and risk tables as structured review content', () => {
  const blocks = artifactMarkdownBlocks(
    '# Plan\n\n- Inspect\n- Implement\n\n| Risk | Mitigation |\n|---|---|\n| Drift | One source |\n\n```ts\nconst safe = true;\n```',
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'list', 'table', 'code'],
  );
  assert.deepEqual(blocks[2], {
    kind: 'table',
    headers: ['Risk', 'Mitigation'],
    rows: [['Drift', 'One source']],
  });
});
