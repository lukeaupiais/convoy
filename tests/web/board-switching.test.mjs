import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const moves = url(compile(await readFile(new URL('../../apps/web/src/features/board/board-moves.ts', import.meta.url), 'utf8')));
const source = compile(await readFile(new URL('../../apps/web/src/features/board/BoardStudio.tsx', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\n/gm, '');
const component = `
import { BoardMoves } from '${moves}';
const {useState,useMemo,useRef,useEffect,useCallback,Activity,BoardView,sourceOwnsBoardField,createPortal,command,writableTicketStatuses,Select,BoardAutomationInspector,Flag,UserRound,GripVertical,LayoutGrid,List,Plus,Settings2,Trash2,X,_jsx,_jsxs} = globalThis.__boardSwitchFixture;
${source}`;

function harness(t) {
  const values = [], effects = [];
  let index = 0, dirty = false, updates = 0;
  const originalDocument = globalThis.document, originalCSS = globalThis.CSS;
  const slot = {};
  globalThis.document = { getElementById: () => slot, addEventListener() {}, removeEventListener() {} };
  globalThis.CSS = { supports: () => true };
  const changed = (before, after) => !before || after.some((value, i) => !Object.is(value, before[i]));
  const jsx = (type, props) => ({ type, props });
  globalThis.__boardSwitchFixture = {
    useState(initial) {
      const key = index++;
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial;
      return [values[key], next => {
        updates++;
        const value = typeof next === 'function' ? next(values[key]) : next;
        if (!Object.is(value, values[key])) { values[key] = value; dirty = true; }
      }];
    },
    useRef(initial) { const key = index++; return values[key] ??= { current: initial }; },
    useMemo(factory, dependencies) {
      const key = index++;
      if (changed(values[key]?.dependencies, dependencies)) values[key] = { dependencies, value: factory() };
      return values[key].value;
    },
    useCallback(callback, dependencies) { return globalThis.__boardSwitchFixture.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) {
      const key = index++;
      if (changed(values[key]?.dependencies, dependencies)) {
        effects.push(() => { values[key]?.cleanup?.(); values[key] = { dependencies, cleanup: effect() }; });
      }
    },
    createPortal: node => node, command: () => { throw new Error('Board switching must not send commands'); },
    writableTicketStatuses: () => null, sourceOwnsBoardField: () => false,
    ...Object.fromEntries(['Activity','BoardView','Select','BoardAutomationInspector','Flag','UserRound','GripVertical','LayoutGrid','List','Plus','Settings2','Trash2','X'].map(name => [name, name])),
    _jsx: jsx, _jsxs: jsx,
  };
  t.after(() => { values.forEach(value => value?.cleanup?.()); globalThis.document = originalDocument; globalThis.CSS = originalCSS; delete globalThis.__boardSwitchFixture; });
  return {
    get updates() { return updates; },
    render(Component, props) {
      let tree, commits = 0;
      do {
        dirty = false; index = 0; tree = Component(props); commits++;
        while (effects.length) effects.shift()();
        assert.ok(commits < 10, 'Board rendering must settle');
      } while (dirty);
      return { tree, commits };
    },
  };
}
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(node => find(node, predicate)).find(Boolean);
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
const board = (id, name) => ({ id, name, projectIds: ['publication'], revision: 1, grouping: { mode: 'local' }, swimlanes: { mode: 'none' }, filters: {}, cardFields: [], columns: [{ id: 'inbox', name: 'Intake', color: '#648d7d' }], tickets: [] });
const props = () => ({
  state: { boards: [board('editorial', 'Editorial'), board('suppliers', 'Suppliers')], boardTemplates: [], projects: [{ id: 'publication' }] },
  projectId: 'publication', tickets: [], projectName: () => 'Publication',
  onSelectTicket() {}, onNewTicket() {}, onManageIntegrations() {}, onOpenWorkflow() {},
});

test('selecting an already loaded board paints in one commit without synchronizing an unused settings draft', async t => {
  const hooks = harness(t);
  const { BoardStudio } = await import(url(component + `\n// ${t.name}`));
  const input = props();
  let rendered = hooks.render(BoardStudio, input);
  const details = find(rendered.tree, node => node.props?.className === 'board-switcher');
  details.props.onToggle({ currentTarget: { open: true } });
  rendered = hooks.render(BoardStudio, input);
  const option = find(rendered.tree, node => node.type === 'button' && node.props.children?.[0] === 'Suppliers');
  assert.ok(option);
  option.props.onClick();
  rendered = hooks.render(BoardStudio, input);
  assert.equal(rendered.commits, 1, 'Board switching must not render the entire card tree twice');
  const summary = find(rendered.tree, node => node.props?.['aria-label'] === 'Choose board');
  assert.equal(summary.props.children[0], 'Suppliers');
  const updates = hooks.updates;
  find(rendered.tree, node => node.props?.className === 'board-switcher').props.onToggle({ currentTarget: { open: false } });
  assert.equal(hooks.updates, updates, 'the native menu close event must not schedule another board render');
});

test('unchanged move state does not add a second render to every ticket poll', async t => {
  const hooks = harness(t);
  const { BoardStudio } = await import(url(component + `\n// ${t.name}`));
  const input = props();
  hooks.render(BoardStudio, input);
  const rendered = hooks.render(BoardStudio, { ...input, tickets: [] });
  assert.equal(rendered.commits, 1, 'Read-only polling should not schedule redundant move-state renders');
});

test('board settings open with the selected board and its latest revision', async t => {
  const hooks = harness(t);
  const { BoardStudio } = await import(url(component + `\n// ${t.name}`));
  const input = props();
  let rendered = hooks.render(BoardStudio, input);
  find(rendered.tree, node => node.props?.className === 'board-switcher').props.onToggle({ currentTarget: { open: true } });
  rendered = hooks.render(BoardStudio, input);
  find(rendered.tree, node => node.type === 'button' && node.props.children?.[0] === 'Suppliers').props.onClick();
  hooks.render(BoardStudio, input);
  const updated = { ...input, state: { ...input.state, boards: [input.state.boards[0], { ...input.state.boards[1], name: 'Supplier assessment', revision: 7 }] } };
  rendered = hooks.render(BoardStudio, updated);
  find(rendered.tree, node => node.props?.['aria-label'] === 'Configure board').props.onClick();
  rendered = hooks.render(BoardStudio, updated);
  assert.ok(find(rendered.tree, node => node.type === 'input' && node.props.value === 'Supplier assessment'), 'opening settings captures the current authoritative board');
});

test('visited board views stay bounded and disappear when board access is removed', async t => {
  const hooks = harness(t);
  const { BoardStudio } = await import(url(component + `\n// ${t.name}`));
  const input = props();
  input.state.boards = Array.from({ length: 5 }, (_, i) => board(`board-${i}`, `Board ${i}`));
  let rendered = hooks.render(BoardStudio, input);
  for (let i = 1; i < 5; i++) {
    find(rendered.tree, node => node.props?.className === 'board-switcher').props.onToggle({ currentTarget: { open: true } });
    rendered = hooks.render(BoardStudio, input);
    find(rendered.tree, node => node.type === 'button' && node.props.children?.[0] === `Board ${i}`).props.onClick();
    rendered = hooks.render(BoardStudio, input);
  }
  const collect = (tree, type) => Array.isArray(tree) ? tree.flatMap(node => collect(node, type)) : !tree || typeof tree !== 'object' ? [] : [...(tree.type === type ? [tree] : []), ...collect(tree.props?.children, type)];
  const activities = collect(rendered.tree, 'Activity');
  assert.equal(activities.length, 3, 'visiting more boards must not retain every card tree');
  assert.equal(activities.filter(node => node.props.mode === 'visible').length, 1);
  const restricted = { ...input, state: { ...input.state, boards: [input.state.boards[0]] } };
  rendered = hooks.render(BoardStudio, restricted);
  const views = collect(rendered.tree, 'BoardView');
  assert.deepEqual(views.map(node => node.props.board.id), ['board-0'], 'cached views cannot retain removed or inaccessible boards');
});
