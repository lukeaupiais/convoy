import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../apps/web/src/app/routes.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseAppRoute, appRouteHash } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('every page round-trips through its shareable hash', () => {
  for (const route of [
    { page: 'Project board' },
    { page: 'Chat' },
    { page: 'Chat', conversationId: 'conv/ä 1' },
    { page: 'Workflows' },
    { page: 'Workflows', runId: 'run-42' },
    { page: 'Sessions' },
    { page: 'Agents' },
    { page: 'Project settings' },
    { page: 'Integrations' },
    { page: 'Providers' },
    { page: 'Runners' },
    { page: 'Chat', conversationId: 'c1', ticket: 16 },
    { page: 'Project board', ticket: 900004 },
  ])
    assert.deepEqual(parseAppRoute(appRouteHash(route)), route);
});

test('settings pages use readable slugs', () => {
  assert.equal(appRouteHash({ page: 'Runners' }), '#/settings/environments');
  assert.equal(appRouteHash({ page: 'Project settings' }), '#/settings/project');
  assert.equal(appRouteHash({ page: 'Project board', ticket: 16 }), '#/board?ticket=16');
});

test('unknown, wiki, and malformed hashes are not app routes', () => {
  assert.equal(parseAppRoute(''), null);
  assert.equal(parseAppRoute('#'), null);
  assert.equal(parseAppRoute('#wiki?project=a'), null);
  assert.equal(parseAppRoute('#/nowhere'), null);
  assert.equal(parseAppRoute('#/settings/unknown'), null);
  assert.equal(parseAppRoute('#/chat/a/b'), null);
  assert.deepEqual(parseAppRoute('#/board?ticket=-3'), { page: 'Project board' });
  assert.deepEqual(parseAppRoute('#/board?ticket=abc'), { page: 'Project board' });
  assert.deepEqual(parseAppRoute('#/chat/%E0%A4%A'), null);
});
