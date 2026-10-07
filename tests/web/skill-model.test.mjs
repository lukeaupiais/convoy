import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/library/skill-model.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {sourceInstance,sourceQualifier,replaceSourceSelection,selectionKey}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('skill observations never select an arbitrary worktree or conflate identical names',()=>{
  const source={id:'one',rootId:'personal-root',name:'review',scope:'personal',relativeDirectory:'review',instances:[{id:'first',runnerId:'desktop',workspaceId:'alpha',digest:'a'},{id:'second',runnerId:'desktop',workspaceId:'beta',digest:'b'}]};
  assert.equal(sourceInstance(source),undefined);
  assert.equal(sourceInstance(source,'desktop'),undefined);
  assert.equal(sourceInstance(source,'desktop','alpha').digest,'a');
  assert.equal(sourceInstance(source,'remote','alpha'),undefined);
  assert.equal(sourceQualifier(source,{roots:[{id:'personal-root',path:'/home/ada/.agents/skills'}]}),'Personal · /home/ada/.agents/skills/review');
  assert.notEqual(sourceQualifier(source,{roots:[]}),sourceQualifier({...source,scope:'project',rootId:'project-root'},{roots:[]}));
});
test('changing a source mode preserves unrelated and unavailable explicit selections',()=>{
  const selected={mode:'source-current',sourceId:'personal-review'};
  const sameNameOtherOrigin={mode:'source-current',sourceId:'project-review'};
  const missing={mode:'snapshot-pinned',snapshotId:'removed',digest:'exact'};
  const pinned={mode:'snapshot-pinned',snapshotId:'new-snapshot',digest:'current'};
  assert.deepEqual(replaceSourceSelection([selected,sameNameOtherOrigin,missing],'personal-review',selected,pinned),[sameNameOtherOrigin,missing,pinned]);
  assert.deepEqual(replaceSourceSelection([selected,sameNameOtherOrigin,missing],'personal-review',selected),[sameNameOtherOrigin,missing]);
  assert.notEqual(selectionKey(selected),selectionKey(sameNameOtherOrigin));
  assert.notEqual(selectionKey(pinned),selectionKey({...pinned,digest:'different'}));
});
