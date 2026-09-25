import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('context selection clears old state and discards an in-flight snapshot from the previous context', async t => {
  const values = [];
  const cleanups = [];
  const pending = [];
  const callbacks = [];
  const originals = Object.fromEntries(['fetch', 'window', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  t.after(() => { cleanups.forEach(cleanup => cleanup()); Object.assign(globalThis, originals); delete globalThis.__runtimeHookFixture; });
  globalThis.window = new EventTarget();
  globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (path, options) => options?.method === 'POST'
    ? Promise.resolve({ ok: true, json: async () => ({ result: {} }) })
    : new Promise(resolve => pending.push(resolve));
  globalThis.__runtimeHookFixture = {
    useState(initial) { const index = values.push(initial) - 1; return [initial, value => { values[index] = value; }]; },
    useEffect(effect) { cleanups.push(effect()); },
  };
  const source = (await readFile(new URL('../../apps/web/src/shared/api/runtime.ts', import.meta.url), 'utf8'))
    .replace("import { useEffect, useState } from 'react';", 'const { useEffect, useState } = globalThis.__runtimeHookFixture;')
    .replace("import { newId } from '../lib/browser';", "const newId = () => 'test-client';");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { useRuntime, command } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  useRuntime();
  await command('selectActiveContext', { context: { organizationId: 'editorial' } });
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'previous' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0], null);
  callbacks.shift()();
  pending.shift()({ ok: true, json: async () => ({ activeContext: { organizationId: 'editorial' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values[0].activeContext.organizationId, 'editorial');
});
