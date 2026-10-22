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
const { WorkflowRunInteraction, WorkflowRecoveryNotice } = await import(
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
      ...example.flow,
    },
  };
  return renderToStaticMarkup(createElement(WorkflowRunInteraction, { session }));
}

test('unconfigured details use readable labels while configured labels and prominence remain visible', () => {
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
    assert.match(html, /<summary>Additional output<\/summary>/);
    assert.match(html, /<dt>Sample size<\/dt><dd>32<\/dd>/);
    assert.match(html, /<dt>Confidence<\/dt><dd>High<\/dd>/);
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

test('empty collections are omitted and bound fields without labels use readable names', () => {
  assert.doesNotMatch(
    render({ nodeId: 'observe', summary: 'Waiting', artifacts: [], references: [] }),
    /Details ·|References ·|Captured files/,
  );
  const html = render(
    { nodeId: 'observe', summary: 'Result', artifacts: [], details: { quantity: '24' } },
    [{ source: 'detail', field: 'quantity' }],
  );
  assert.match(html, /<dt>Quantity<\/dt><dd>24<\/dd>/);
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

test('a single unconfigured detail remains visible with a readable field label', () => {
  const html = render({
    nodeId: 'observe',
    summary: 'Result',
    artifacts: [],
    details: { disposition: 'Hold for inspection' },
  });
  assert.match(html, /<dl class="workflow-output-fields">/);
  assert.doesNotMatch(html, /Details · 1/);
  assert.match(html, /<dt>Disposition<\/dt><dd>Hold for inspection<\/dd>/);
});

test('secondary analysis opens independently without execution metadata in the ticket', () => {
  for (const producer of ['Measure samples', 'Edit manuscript']) {
    const html = render({
      nodeId: 'previous-step',
      step: producer,
      revision: 7,
      summary: 'Captured analysis',
      artifacts: [],
      details: { result: 'Material to review' },
    });
    assert.match(html, /<small>Current step<\/small>/);
    assert.match(html, /<h2>Observe result<\/h2>/);
    assert.match(html, /<details class="workflow-supporting-summary workflow-output-disclosure"><summary>Analysis<\/summary>/);
    assert.ok(html.indexOf('Material to review') < html.indexOf('<summary>Analysis</summary>'));
    assert.doesNotMatch(html, /Produced by|Submission revision|<summary>Details<\/summary>/);
    assert.ok(!html.includes(producer));
    assert.match(html, /Captured analysis/);
  }
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
  assert.match(html, /<dt>Schedule<\/dt>/);
  assert.doesNotMatch(html, /workflow-supporting-summary/);
});

test('unconfigured field labels are readable across unrelated workflows without changing values', () => {
  for (const [field, label] of [
    ['decisionMemo', 'Decision memo'],
    ['count_reconciliation', 'Count reconciliation'],
  ]) {
    const html = render({
      nodeId: 'observe',
      summary: 'Analysis',
      artifacts: [],
      details: { [field]: 'Keep exact_material.' },
    });
    assert.ok(html.includes(`<dt>${label}</dt><dd>Keep exact_material.</dd>`));
  }
  const configured = render(
    {
      nodeId: 'observe',
      summary: 'Analysis',
      artifacts: [],
      details: { decisionMemo: 'Captured text' },
    },
    [{ source: 'detail', field: 'decisionMemo', label: 'Decision document' }],
  );
  assert.match(configured, /<dt>Decision document<\/dt>/);
});

test('failed activity leads with recovery and keeps the exact recorded error in a closed disclosure', () => {
  const html = render(undefined, [], {
    status: 'failed',
    flow: { status: 'failed' },
    events: [{ seq: 1, type: 'submission_rejected', message: 'Expected <countValue>.' }],
  });
  assert.doesNotMatch(html, />Recovery required</);
  assert.match(html, /Step failed/);
  assert.match(html, /Expected &lt;countValue&gt;\./);
  assert.doesNotMatch(html, /<summary>Details<\/summary>/);
  assert.doesNotMatch(html, /<small aria-label="Execution status/);
});

test('uncertain assignment takes precedence over an older failed event in recovery', () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowRecoveryNotice, {
      session: {
        status: 'failed',
        flow: { status: 'failed' },
        assignment: { state: 'uncertain', message: 'Inspect the original runner.' },
        events: [{ type: 'submission_rejected', message: 'Old validation error' }],
      },
    }),
  );
  assert.match(html, /Execution outcome uncertain/);
  assert.match(html, /Inspect the original runner\./);
  assert.doesNotMatch(html, /Old validation error|Step failed/);
});

// Isolate the ticket presentation from session controls; the browser check covers
// their real composition. Any accidental command during render fails this test.
const ticketSource = await readFile(
  new URL('../../apps/web/src/features/tickets/TicketExecution.tsx', import.meta.url),
  'utf8',
);
let ticketJs = ts
  .transpileModule(ticketSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '');
const stubUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const ticketImports = {
  '../../shared/api/runtime': stubUrl(
    'export const owns = () => false; export const command = () => { throw new Error("Unexpected render mutation"); };',
  ),
  '../../shared/lib/browser': stubUrl('export const newId = () => "test";'),
  '../../shared/ui/Select': stubUrl('export const Select = () => null;'),
  '../sessions': stubUrl('export const SessionControls = ({advancedContent}) => advancedContent;'),
  '../library': stubUrl(
    'export const ProfilePicker = () => null; export const profileRef = () => undefined;',
  ),
  '../workflows': stubUrl(
    'export const WorkflowRecoveryNotice = ({children}) => children; export const WorkflowRunDetails = () => "Technical evidence";',
  ),
};
ticketJs = ticketJs.replace(
  /from ['"]([^'"]+)['"]/g,
  (_, name) => `from '${ticketImports[name] ?? import.meta.resolve(name)}'`,
);
const { TicketExecution } = await import(stubUrl(ticketJs));

test('ticket recovery leads with controls and keeps technical evidence collapsed, including when disconnected', () => {
  for (const example of [
    { board: 'Quarterly Journal', workType: 'Essay', status: 'Copy desk' },
    { board: 'Warehouse North', workType: 'CycleCount', status: 'Awaiting recount' },
  ]) {
    for (const runtimeAvailable of [true, false]) {
      for (const uncertain of [false, true]) {
        const session = {
          id: 'session',
          activeTicketId: 42,
          status: 'failed',
          flow: { id: 'run', instance: 'exact-attempt', nodeId: 'process', status: 'failed' },
          workflow: { nodes: [{ id: 'process', name: 'Process material' }] },
          ...(uncertain ? { assignment: { state: 'uncertain' } } : {}),
        };
        const html = renderToStaticMarkup(
          createElement(TicketExecution, {
            ticket: { id: 42, executionSessionId: 'session', projectId: 'project', ...example },
            state: { sessions: [session], projects: [], workflows: [], models: [] },
            runtimeAvailable,
            focusRecovery: true,
          }),
        );
        assert.ok(html.indexOf('Continue workflow') >= 0);
        assert.ok(html.indexOf('Continue workflow') < html.indexOf('Technical evidence'));
        assert.match(html, /<details class="execution-evidence"><summary>Execution details/);
        assert.equal(
          /<button class="primary" disabled="">Continue workflow/.test(html),
          !runtimeAvailable || uncertain,
        );
      }
    }
  }
});

const sessionSource = await readFile(
  new URL('../../apps/web/src/features/sessions/RuntimeViews.tsx', import.meta.url),
  'utf8',
);
let sessionJs = ts
  .transpileModule(sessionSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '');
const sessionImports = {
  '../../shared/api/runtime': stubUrl(
    'export const owns = () => false; export const useRuntime = () => ({}); export const command = () => { throw new Error("Unexpected render mutation"); };',
  ),
  './sessionMonitor': stubUrl(
    'export const liveModel = () => null; export const sessionProjectId = () => null; export const sessionStatus = () => null;',
  ),
  '../library': stubUrl('export const SessionCapabilities = () => null;'),
  '../workflows': stubUrl(
    'export const WorkflowActivityHistory = () => null; export const WorkflowRunDetails = () => null; export const WorkflowRunInteraction = () => null; export const requiredGateActivityTarget = () => undefined; export const workflowHumanTaskActions = () => ({});',
  ),
};
sessionJs = sessionJs.replace(
  /from ['"]([^'"]+)['"]/g,
  (_, name) => `from '${sessionImports[name] ?? import.meta.resolve(name)}'`,
);
const { SessionControls } = await import(stubUrl(sessionJs));

test('session details collapse ordinary metadata but open for unresolved outcomes and disconnects', () => {
  const session = {
    id: 'session',
    activeTicketId: 42,
    status: 'failed',
    instructions: [],
    flow: { id: 'run', instance: 'attempt', nodeId: 'node', status: 'failed' },
  };
  for (const example of [
    { expectedOpen: false },
    { expectedOpen: true, runtimeAvailable: false },
    {
      expectedOpen: true,
      assignment: { state: 'uncertain', message: 'Inspect original execution.' },
    },
    {
      expectedOpen: true,
      effects: [{ effectKey: 'run:attempt:node', status: 'uncertain', operation: 'update_ticket' }],
    },
    {
      expectedOpen: true,
      decisions: [{ ticketId: 42, status: 'failed', workflowVersion: 1, triggerKey: 'automation' }],
    },
    {
      expectedOpen: false,
      effects: [
        { effectKey: 'another-run:attempt:node', status: 'uncertain', operation: 'update_ticket' },
      ],
    },
  ]) {
    const html = renderToStaticMarkup(
      createElement(SessionControls, {
        session: { ...session, ...(example.assignment ? { assignment: example.assignment } : {}) },
        state: {
          workflows: [],
          runners: [],
          workflowEffects: example.effects,
          automationDecisions: example.decisions,
        },
        disclosure: true,
        openRecovery: true,
        showWorkflowInteraction: false,
        runtimeAvailable: example.runtimeAvailable ?? true,
      }),
    );
    assert.equal(
      html.startsWith('<details class="session-controls-disclosure" open="">'),
      example.expectedOpen,
    );
    if (example.effects?.[0].effectKey === 'run:attempt:node') {
      assert.match(html, /Confirm applied/);
      assert.match(html, /disabled=""/);
    }
  }
});


test('existing prose labels are scannable without rewriting output or guessing customer sections', () => {
  for (const label of ['Measured samples', 'Editorial decision']) {
    const html = render({
      nodeId: 'observe',
      summary: `${label}: Keep **recorded** content.\n\nhttps://example.test/path\n\nUnlabelled paragraph.`,
      artifacts: [],
      details: { result: 'Review material' },
    });
    assert.ok(html.includes(`<strong class="workflow-paragraph-label">${label}:</strong>`));
    assert.match(html, /Keep <strong>recorded<\/strong> content\./);
    assert.match(html, /<p>https:\/\/example\.test\/path<\/p><p>Unlabelled paragraph\.<\/p>/);
    assert.doesNotMatch(html, /class="workflow-paragraph-label">https/);
  }
});
