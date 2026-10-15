import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const modules = new Map();
async function compile(path) {
  if (modules.has(path)) return modules.get(path);
  const source = await readFile(path, 'utf8');
  let js = ts
    .transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '');
  const names = [...new Set([...js.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]))];
  for (const name of names) {
    let url;
    if (name.startsWith('.')) {
      const stem = resolve(dirname(path), name);
      let found;
      for (const candidate of [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.mjs`]) {
        try {
          await access(candidate);
          found = candidate;
          break;
        } catch {
          /* next extension */
        }
      }
      if (!found) throw new Error(`Unresolved test import: ${name}`);
      url = await compile(found);
    } else url = import.meta.resolve(name);
    js = js
      .replaceAll(`from '${name}'`, `from '${url}'`)
      .replaceAll(`from "${name}"`, `from "${url}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
  modules.set(path, url);
  return url;
}
const { WorkflowRunInteraction } = await import(
  await compile(
    fileURLToPath(
      new URL('../../apps/web/src/features/workflows/WorkflowRunInteraction.tsx', import.meta.url),
    ),
  )
);

function render(submission, bindings = [], example = {}) {
  const session = {
    id: 'output-session',
    events: [],
    status: 'idle',
    ...example,
    workflow: {
      nodes: [
        { id: 'observe', name: 'Observe result', kind: 'check', presentationBindings: bindings },
      ],
      edges: [],
    },
    flow: {
      id: 'run',
      instance: 'attempt',
      nodeId: 'observe',
      status: 'waiting_event',
      history: [],
      lastSubmission: submission,
    },
  };
  return renderToStaticMarkup(createElement(WorkflowRunInteraction, { session }));
}

test('unconfigured details retain field names while configured labels and prominence remain visible', () => {
  for (const example of [
    { board: 'Quarterly Journal', workType: 'Essay', ticketStatus: 'Copy desk' },
    { board: 'Warehouse North', workType: 'CycleCount', ticketStatus: 'Awaiting recount' },
  ]) {
    const html = render(
      {
        nodeId: 'observe',
        summary: 'Captured result',
        artifacts: [],
        details: { conclusion: 'Configured value', sample_size: '32', confidence: 'High' },
      },
      [{ source: 'detail', field: 'conclusion', label: 'Finding', primary: true }],
      example,
    );
    assert.match(html, /<strong>Finding<\/strong>/);
    assert.match(html, /Details · 2/);
    assert.match(html, /<dt>sample_size<\/dt><dd>32<\/dd>/);
    assert.match(html, /<dt>confidence<\/dt><dd>High<\/dd>/);
    assert.doesNotMatch(html, /Supporting output|References ·/);
  }
});

test('reference-only output exposes a bounded collection without dumping excerpts into the ticket', () => {
  const references = Array.from({ length: 120 }, (_, i) => ({
    path: `measurements/region-${i}.txt`,
    startLine: 1,
    endLine: 4,
    sha256: 'fixture',
    text: `Captured excerpt ${i}`,
  }));
  const html = render({
    nodeId: 'observe',
    summary: 'Review measurements',
    artifacts: [],
    references,
  });
  assert.match(html, /References · 120/);
  assert.match(html, /aria-label="Open references, 120 references"/);
  assert.doesNotMatch(html, /Captured excerpt|region-119|Captured files|Details ·|<dialog/);
});

test('empty collections are omitted and bound fields without labels retain their names', () => {
  assert.doesNotMatch(
    render({ nodeId: 'observe', summary: 'Waiting', artifacts: [], references: [] }),
    /Details ·|References ·|Captured files/,
  );
  const html = render(
    { nodeId: 'observe', summary: 'Result', artifacts: [], details: { quantity: '24' } },
    [{ source: 'detail', field: 'quantity' }],
  );
  assert.match(html, /<dt>quantity<\/dt><dd>24<\/dd>/);
  assert.doesNotMatch(html, /Details ·/);
});

test('an explicitly designated review field leads the summary across unrelated workflows', () => {
  for (const field of ['decision_memo', 'count_reconciliation']) {
    const html = render(
      {
        nodeId: 'observe',
        summary: 'Supporting analysis',
        artifacts: [],
        details: { [field]: 'Material to decide on' },
      },
      [{ source: 'detail', field, label: 'Review material', primary: true }],
    );
    assert.ok(html.indexOf('Material to decide on') < html.indexOf('Supporting analysis'));
    assert.match(html, /workflow-supporting-summary/);
    assert.doesNotMatch(html, /<dialog/);
  }
});

test('a single unconfigured detail remains visible with its source field name', () => {
  const html = render({
    nodeId: 'observe',
    summary: 'Result',
    artifacts: [],
    details: { disposition: 'Hold for inspection' },
  });
  assert.match(html, /<dl class="workflow-output-fields">/);
  assert.doesNotMatch(html, /Details · 1/);
  assert.match(html, /<dt>disposition<\/dt><dd>Hold for inspection<\/dd>/);
});

test('retained output identifies its producing activity and revision separately from the current step', () => {
  const html = render({
    nodeId: 'measure',
    step: 'Measure samples',
    revision: 7,
    summary: 'Measured values',
    artifacts: [],
  });
  assert.match(html, /Observe result/);
  assert.match(html, /Output from Measure samples/);
  assert.match(html, /Revision 7/);
});

test('summary renders safe Markdown structure while detail values retain their exact text', () => {
  const html = render({
    nodeId: 'observe',
    step: 'Observe result',
    revision: 1,
    summary: '# Findings\n\nFirst paragraph.\n\n- Measured **twice**\n- <script>alert(1)</script>',
    details: { release_note: 'Keep **literal** characters.' },
    artifacts: [],
  });
  assert.match(html, /<h2>Findings<\/h2>/);
  assert.match(html, /<p>First paragraph\.<\/p>/);
  assert.match(html, /<li>Measured <strong>twice<\/strong><\/li>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<dd>Keep \*\*literal\*\* characters\.<\/dd>/);
});

test('a summary explicitly marked primary remains visible beside a single unconfigured detail', () => {
  const html = render(
    {
      nodeId: 'observe',
      step: 'Observe result',
      summary: 'Main analysis',
      artifacts: [],
      details: { schedule: 'Next week' },
    },
    [{ source: 'summary', primary: true }],
  );
  assert.match(html, /Main analysis/);
  assert.match(html, /<dt>schedule<\/dt>/);
  assert.doesNotMatch(html, /workflow-supporting-summary/);
});
