import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('context selection clears old state and discards an in-flight snapshot from the previous context', async t => {
  const values = [];
  const cleanups = [];
  const pending = [];
  const callbacks = [];
  const paths = [];
  const originals = Object.fromEntries(['fetch', 'window', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  t.after(() => { cleanups.forEach(cleanup => cleanup()); Object.assign(globalThis, originals); delete globalThis.__runtimeHookFixture; });
  globalThis.window = new EventTarget();
  globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (path, options) => {
    paths.push(path);
    return options?.method === 'POST'
      ? Promise.resolve({ ok: true, json: async () => ({ result: {} }) })
      : new Promise(resolve => pending.push(resolve));
  };
  globalThis.__runtimeHookFixture = {
    useState(initial) { const index = values.push(initial) - 1; return [initial, value => { values[index] = value; }]; },
    useEffect(effect) { cleanups.push(effect()); },
  };
  const source = (await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8'))
    .replace("import { useEffect, useState } from 'react';", 'const { useEffect, useState } = globalThis.__runtimeHookFixture;')
    .replace("import { newId } from '../lib/browser';", "const newId = () => 'test-client';");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { useRuntime, command } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  useRuntime(undefined, true);
  assert.equal(paths[0], '/api/runtime?view=overview');
  await command('selectActiveContext', { context: { organizationId: 'editorial' } });
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'previous' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0], null);
  callbacks.shift()();
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'editorial' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0].activeContext.organizationId, 'editorial');
  useRuntime(7, true);
  assert.equal(paths.at(-1), '/api/runtime/7');
});

test('runtime failures retain an uncertainty code for explicit save recovery', async t => {
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async()=>({ok:false,json:async()=>({error:'Save outcome is uncertain.',code:'UNCERTAIN'})});
  const source=(await readFile(new URL('../../apps/web/src/shared/api/runtime.ts',import.meta.url),'utf8'))
    .replace("import { useEffect, useState } from 'react';",'const useEffect=()=>{},useState=()=>{};')
    .replace("import { newId } from '../lib/browser';","const newId=()=> 'uncertainty-test';");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {api,RuntimeApiError}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  await assert.rejects(api('/api/runtime',{action:'saveSkillSource'}),error=>error instanceof RuntimeApiError && error.code==='UNCERTAIN' && error.message==='Save outcome is uncertain.');
});

test('unknown file-backed skill mutation outcomes require inspection without replaying the request', async t => {
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  const source=(await readFile(new URL('../../apps/web/src/shared/api/runtime.ts',import.meta.url),'utf8'))
    .replace("import { useEffect, useState } from 'react';",'const useEffect=()=>{},useState=()=>{};')
    .replace("import { newId } from '../lib/browser';","const newId=()=> 'lost-reply-test';");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {command,RuntimeApiError}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  for(const action of ['saveSkillSource','createSkillSource','provisionSkillSnapshot','saveStoredSkillToFolder']) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;throw new TypeError('Failed to fetch');};
    await assert.rejects(command(action,{requestId:'exact-request'}),error=>error instanceof RuntimeApiError && error.code==='UNCERTAIN');
    assert.equal(calls,1,'An unknown mutation must never be retried automatically.');
  }
  for(const response of [
    {ok:true,status:200,json:async()=>{throw new SyntaxError('Truncated response');}},
    {ok:true,status:200,json:async()=>({ok:true})},
    {ok:false,status:500,json:async()=>({error:'Local backend error.'})},
    {ok:false,status:409,json:async()=>{throw new SyntaxError('Truncated recovery response');}},
    {ok:false,status:409,json:async()=>({error:'Unknown recovery outcome.'})},
  ]) {
    globalThis.fetch=async()=>response;
    await assert.rejects(command('saveSkillSource',{requestId:'exact-request'}),error=>error instanceof RuntimeApiError && error.code==='UNCERTAIN');
  }
  globalThis.fetch=async()=>({ok:false,status:400,json:async()=>({error:'Skill path denied.'})});
  await assert.rejects(command('saveSkillSource',{}),error=>error instanceof RuntimeApiError && error.code===undefined && error.status===400 && error.message==='Skill path denied.');
  for(const response of [{ok:false,status:400,json:async()=>null},{ok:false,status:400,json:async()=>{throw new SyntaxError('Malformed rejection');}}]) {globalThis.fetch=async()=>response;await assert.rejects(command('saveSkillSource',{}),error=>error instanceof RuntimeApiError && error.code===undefined && error.status===400);}
  globalThis.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Source changed.',code:'CONFLICT'})});
  await assert.rejects(command('saveSkillSource',{}),error=>error instanceof RuntimeApiError && error.code==='CONFLICT' && error.status===409);
  const readFailure=new TypeError('Read connection failed');
  globalThis.fetch=async()=>{throw readFailure;};
  await assert.rejects(command('readSkillSource',{sourceId:'source'}),error=>error===readFailure);
});
