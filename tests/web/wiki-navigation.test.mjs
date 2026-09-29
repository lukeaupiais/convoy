import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/knowledge/wiki-navigation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseWikiLocation, wikiHref } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('shareable wiki locations preserve project, exact revision and Unicode heading', () => {
  const route = { projectId: 'project-a', collectionId: 'manual', pageId: 'page-a', version: 3, section: 'ação & result' };
  assert.deepEqual(parseWikiLocation(wikiHref(route)), route);
  assert.equal(parseWikiLocation('#unrelated'), null);
  assert.equal(parseWikiLocation('#wiki?page=a&version=-1').version, undefined);
  assert.equal(parseWikiLocation('#wiki?page=a&version=1.2').version, undefined);
});
