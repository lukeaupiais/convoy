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
    useRef(initial) { return { current: initial }; },
    useEffect(effect) { cleanups.push(effect()); },
  };
  const source = (await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8'))
    .replace("import { useEffect, useRef, useState } from 'react';", 'const { useEffect, useRef, useState } = globalThis.__runtimeHookFixture;')
    .replace("import { newId } from '../lib/browser';", "const newId = () => 'test-client';");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { useRuntime, command } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  useRuntime(undefined, true);
  assert.equal(paths[0], '/api/runtime?view=overview');
  await command('selectActiveContext', { context: { organizationId: 'editorial' } });
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'previous' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0], null);
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'editorial' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0].activeContext.organizationId, 'editorial');
  useRuntime(7, true);
  assert.equal(paths.at(-1), '/api/runtime/7');
  useRuntime('chat-12345678-1234-1234-1234-123456789abc');
  assert.equal(paths.at(-1), '/api/runtime/chat-12345678-1234-1234-1234-123456789abc',
    'conversation detail must request its selected session rather than every session');
});

test('reconnect refresh retains stale data after failure and replaces it only with an authoritative snapshot', async t => {
  const original = Object.fromEntries(['fetch', 'window', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  const values = [];
  let hookIndex = 0;
  let cleanup;
  let effectStarted = false;
  let effectDependencies = [];
  const requests = [];
  const timers = [];
  t.after(() => { cleanup?.(); Object.assign(globalThis, original); delete globalThis.__runtimeHookFixture; });
  globalThis.window = new EventTarget();
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
  globalThis.__runtimeHookFixture = {
    beginRender() { hookIndex = 0; },
    useState(initial) {
      const index = hookIndex++;
      if (!(index in values)) values[index] = initial;
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useEffect(effect, dependencies) {
      hookIndex++;
      const changed = dependencies.some((value, index) => !Object.is(value, effectDependencies[index]));
      if (!effectStarted || changed) {
        cleanup?.();
        effectStarted = true;
        effectDependencies = dependencies;
        cleanup = effect();
      }
    },
  };
  const source = (await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8'))
    .replace("import { useEffect, useRef, useState } from 'react';", 'const { useEffect, useRef, useState } = globalThis.__runtimeHookFixture;')
    .replace("import { newId } from '../lib/browser';", "const newId = () => 'reconnect-test';");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { useRuntime } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const render = () => { globalThis.__runtimeHookFixture.beginRender(); return useRuntime(); };

  let runtime = render();
  assert.equal(runtime.isStale, true, 'No confirmed snapshot means mutations stay unavailable.');
  requests[0].resolve({ ok: true, json: async () => ({ marker: 'first' }) });
  await new Promise(resolve => setImmediate(resolve));
  runtime = render();
  assert.equal(runtime.state.marker, 'first');
  assert.equal(runtime.isStale, false);

  timers.shift()();
  requests[1].reject(new TypeError('offline'));
  await new Promise(resolve => setImmediate(resolve));
  runtime = render();
  assert.equal(runtime.state.marker, 'first', 'A failed poll retains the last known snapshot.');
  assert.equal(runtime.isStale, true);
  assert.match(runtime.error, /may still be running/);

  runtime.refresh();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].path, '/api/runtime');
  assert.notEqual(requests[2].options?.method, 'POST', 'Reconnect only reads an authoritative snapshot.');
  runtime = render();
  assert.equal(runtime.isRefreshing, true);
  assert.equal(runtime.isStale, true);
  requests[2].resolve({ ok: true, json: async () => ({ marker: 'refreshed' }) });
  await new Promise(resolve => setImmediate(resolve));
  runtime = render();
  assert.equal(runtime.state.marker, 'refreshed');
  assert.equal(runtime.error, '');
  assert.equal(runtime.isRefreshing, false);
  assert.equal(runtime.isStale, false);

  runtime.refresh();
  requests[3].reject(new TypeError('still offline'));
  await new Promise(resolve => setImmediate(resolve));
  runtime = render();
  assert.equal(runtime.state.marker, 'refreshed', 'A failed manual refresh keeps the most recent snapshot.');
  assert.equal(runtime.isRefreshing, false, 'A failed refresh ends its pending state.');
  assert.equal(runtime.isStale, true);
});

test('scope changes keep retained data stale and discard a superseded reconnect response', async t => {
  const original = Object.fromEntries(['fetch', 'window', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  const values = [];
  let hookIndex = 0;
  let cleanup;
  let effectDependencies = [];
  let effectStarted = false;
  const requests = [];
  t.after(() => { cleanup?.(); Object.assign(globalThis, original); delete globalThis.__runtimeHookFixture; });
  globalThis.window = new EventTarget();
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
  globalThis.__runtimeHookFixture = {
    beginRender() { hookIndex = 0; },
    useState(initial) {
      const index = hookIndex++;
      if (!(index in values)) values[index] = initial;
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useEffect(effect, dependencies) {
      hookIndex++;
      const changed = dependencies.some((value, index) => !Object.is(value, effectDependencies[index]));
      if (!effectStarted || changed) {
        cleanup?.();
        effectStarted = true;
        effectDependencies = dependencies;
        cleanup = effect();
      }
    },
  };
  const source = (await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8'))
    .replace("import { useEffect, useRef, useState } from 'react';", 'const { useEffect, useRef, useState } = globalThis.__runtimeHookFixture;')
    .replace("import { newId } from '../lib/browser';", "const newId = () => 'scope-switch-test';");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { useRuntime } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const render = (taskId) => { globalThis.__runtimeHookFixture.beginRender(); return useRuntime(taskId); };

  let runtime = render(undefined);
  requests[0].resolve({ ok: true, json: async () => ({ marker: 'overview' }) });
  await new Promise(resolve => setImmediate(resolve));
  runtime = render(undefined);
  assert.equal(runtime.isStale, false);

  runtime.refresh();
  runtime = render(undefined);
  assert.equal(runtime.isRefreshing, true);
  runtime = render(9);
  assert.equal(requests[2].path, '/api/runtime/9');
  assert.equal(runtime.state.marker, 'overview', 'The old snapshot stays visible while the new scope loads.');
  assert.equal(runtime.isStale, true, 'A snapshot from another scope cannot authorize actions.');

  requests[1].resolve({ ok: true, json: async () => ({ marker: 'superseded' }) });
  requests[2].resolve({ ok: true, json: async () => ({ marker: 'ticket-9' }) });
  await new Promise(resolve => setImmediate(resolve));
  runtime = render(9);
  assert.equal(runtime.state.marker, 'ticket-9');
  assert.equal(runtime.isRefreshing, false);
  assert.equal(runtime.isStale, false);
});

test('runtime failures retain an uncertainty code for explicit save recovery', async t => {
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async()=>({ok:false,json:async()=>({error:'Save outcome is uncertain.',code:'UNCERTAIN'})});
  const source=(await readFile(new URL('../../apps/web/src/shared/api/runtime.ts',import.meta.url),'utf8'))
    .replace("import { useEffect, useRef, useState } from 'react';",'const useEffect=()=>{},useState=()=>{},useRef=initial=>({current:initial});')
    .replace("import { newId } from '../lib/browser';","const newId=()=> 'uncertainty-test';");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {api,RuntimeApiError}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  await assert.rejects(api('/api/runtime',{action:'saveSkillSource'}),error=>error instanceof RuntimeApiError && error.code==='UNCERTAIN' && error.message==='Save outcome is uncertain.');
});

test('unknown file-backed skill mutation outcomes require inspection without replaying the request', async t => {
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  const source=(await readFile(new URL('../../apps/web/src/shared/api/runtime.ts',import.meta.url),'utf8'))
    .replace("import { useEffect, useRef, useState } from 'react';",'const useEffect=()=>{},useState=()=>{},useRef=initial=>({current:initial});')
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
