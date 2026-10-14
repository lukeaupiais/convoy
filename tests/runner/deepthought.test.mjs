import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, mkdir, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRpc } from '../../packages/runner/src/index.mjs';
import { createExecutionPolicy } from '../../apps/daemon/src/modules/execution/index.mjs';
import { processRun } from '../../packages/runner/src/index.mjs';
import {
  createDeepThoughtAdapter,
  deepThoughtExtensionManifest,
  executeRunner,
} from '../../packages/runner/src/index.mjs';

const python = process.env.CONVOY_TEST_DEEPTHOUGHT_PYTHON;
const manifest = deepThoughtExtensionManifest;
const extension = {
  id: manifest.id,
  revision: manifest.revision,
  hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
};

test(
  'unresolved semantic results stay partial even when index ingestion succeeds',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-unresolved-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = spawnSync(python, [
      '-I',
      '-B',
      '-c',
      "from deepthought._scip import scip_pb2 as w; import sys; i=w.Index(); i.metadata.tool_info.name='fixture'; d=i.documents.add(relative_path='main.py',position_encoding=w.UTF8CodeUnitOffsetFromLineStart); d.occurrences.add(symbol='local 0',range=[0,0,3]); open(sys.argv[1],'wb').write(i.SerializeToString())",
      join(root, 'index.scip'),
    ]);
    assert.equal(fixture.status, 0);
    const adapter = await createDeepThoughtAdapter({ python });
    const result = await executeRunner(
      {
        action: 'extension',
        workspace: root,
        adapter: 'deepthought',
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'references', symbol: 'local 0', index: 'index.scip' },
      },
      undefined,
      undefined,
      undefined,
      { deepthought: adapter },
    );
    assert.equal(result.analysis_status, 'succeeded');
    assert.equal(result.status, 'partial');
    assert.equal(result.matches[0].resolution, 'unresolved');
  },
);

for (const worker of ['source', ...(process.env.CONVOY_TEST_COMPILED_WORKER ? ['compiled'] : [])]) {
  test(
    `${worker} portable worker discovers an explicitly provisioned adapter and executes the same extension protocol`,
    { skip: !python },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-rpc-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, 'source.py'), 'def portable(): pass\n');
      const env = { ...process.env, CONVOY_DEEPTHOUGHT_PYTHON: python };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(
        worker === 'source' ? process.execPath : process.env.CONVOY_TEST_COMPILED_WORKER,
        worker === 'source' ? ['apps/worker/src/worker.mjs'] : [],
        {
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
        },
      );
      const rpc = createRpc(child.stdout, child.stdin);
      t.after(() => {
        rpc.close();
        child.stdin.end();
        child.kill();
      });
      const result = await rpc.call('execute', {
        action: 'extension',
        operationId: randomUUID(),
        workspace: root,
        adapter: 'deepthought',
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions', symbol: 'portable' },
      });
      assert.equal(result.matches[0].symbol, 'portable');
    },
  );
}

test(
  'reviewed DeepThought extension runs the separately installed SDK through the assigned runner',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'source.py'), 'class Widget:\n    def execute(self): pass\n');
    const adapter = await createDeepThoughtAdapter({ python });
    const result = await executeRunner(
      {
        action: 'extension',
        workspace: root,
        adapter: 'deepthought',
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions', symbol: 'Widget.execute' },
      },
      undefined,
      undefined,
      undefined,
      { deepthought: adapter },
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.capabilities, ['definitions']);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].file, 'source.py');
    assert.equal(result.matches[0].symbol, 'Widget.execute');
    assert.equal(result.matches[0].line, 2);
    await assert.rejects(access(join(root, '__pycache__')));
  },
);

test('runtime discovery is cancellable and leaves the shared event loop responsive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slow = join(root, 'python');
  await writeFile(slow, '#!/bin/sh\nexec /usr/bin/sleep 5\n', { mode: 0o700 });
  const previous = process.env.CONVOY_DEEPTHOUGHT_PYTHON;
  process.env.CONVOY_DEEPTHOUGHT_PYTHON = slow;
  t.after(() => {
    if (previous === undefined) delete process.env.CONVOY_DEEPTHOUGHT_PYTHON;
    else process.env.CONVOY_DEEPTHOUGHT_PYTHON = previous;
  });
  const cancel = new AbortController();
  const started = Date.now();
  const request = executeRunner(
    {
      action: 'extension',
      workspace: root,
      adapter: 'deepthought',
      extension,
      tool: 'extension.deepthought.query',
      args: { operation: 'definitions' },
    },
    cancel.signal,
  );
  let timerElapsed;
  setTimeout(() => {
    timerElapsed = Date.now() - started;
    cancel.abort();
  }, 25);
  await assert.rejects(request, /cancelled/);
  assert(timerElapsed < 500, `Shared event loop blocked for ${timerElapsed}ms`);
});

test(
  'queries preserve SCIP alias targets, reference semantics and incomplete coverage',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-index-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await copyFile('tests/support/deepthought/typescript.scip', join(root, 'index.scip'));
    const adapter = await createDeepThoughtAdapter({ python });
    const invoke = (args) =>
      executeRunner(
        {
          action: 'extension',
          workspace: root,
          adapter: 'deepthought',
          extension,
          tool: 'extension.deepthought.query',
          args,
        },
        undefined,
        undefined,
        undefined,
        { deepthought: adapter },
      );
    const refs = await invoke({
      operation: 'references',
      index: 'index.scip',
      symbol:
        'scip-typescript npm deepthought-typescript-fixture 0.0.0 other/`helpers.ts`/helper().',
    });
    assert.equal(refs.status, 'partial');
    assert.equal(refs.total_matches, 3);
    assert.deepEqual(
      refs.matches.map((r) => r.reference.line).sort((a, b) => a - b),
      [3, 3, 14],
    );
    assert(refs.matches.every((r) => r.resolution === 'resolved'));
    const dependencies = await invoke({
      operation: 'dependencies',
      index: 'index.scip',
      file: 'main.ts',
    });
    assert.equal(dependencies.total_matches, 3);
    assert(
      dependencies.matches.every(
        (edge) => edge.relation === 'references' && edge.witness_count > 0,
      ),
    );
    const unavailable = await invoke({ operation: 'references', symbol: 'helper' });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.total_matches, 0);
  },
);

test(
  'runner confinement ignores repository Python configuration, symlink escapes and parent files',
  { skip: !python },
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'convoy-deepthought-confinement-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'workspace');
    await mkdir(root);
    await writeFile(join(parent, 'secret.py'), 'class Confidential: pass\n');
    await symlink(join(parent, 'secret.py'), join(root, 'escape.py'));
    await writeFile(
      join(root, 'deepthought.py'),
      "raise RuntimeError('Repository module executed')\n",
    );
    await writeFile(
      join(root, 'source.py'),
      "from pathlib import Path\nPath('EXECUTED').write_text('wrong')\ndef owned(): pass\n",
    );
    const adapter = await createDeepThoughtAdapter({ python });
    const invoke = (args) =>
      executeRunner(
        {
          action: 'extension',
          workspace: root,
          adapter: 'deepthought',
          extension,
          tool: 'extension.deepthought.query',
          args,
        },
        undefined,
        undefined,
        undefined,
        { deepthought: adapter },
      );
    const result = await invoke({ operation: 'definitions' });
    assert.equal(result.status, 'partial');
    assert(result.matches.some((d) => d.symbol === 'owned'));
    assert(!result.matches.some((d) => d.symbol === 'Confidential'));
    await assert.rejects(access(join(root, 'EXECUTED')));
    for (const index of ['../secret.scip', '/etc/passwd', 'a/../secret.scip', 'a\\b.scip'])
      await assert.rejects(invoke({ operation: 'definitions', index }), /canonical/);
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'nested.py'), 'class Nested: pass\n');
    const scoped = await executeRunner(
      {
        action: 'extension',
        workspace: root,
        workingDirectory: 'nested',
        adapter: 'deepthought',
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions' },
      },
      undefined,
      undefined,
      undefined,
      { deepthought: adapter },
    );
    assert.deepEqual(
      scoped.matches.map((d) => d.symbol),
      ['Nested'],
    );
  },
);

test(
  'adapter rejects stale pins, cancellation, timeouts and oversized output with settled child lifecycles',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-lifecycle-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'source.py'), 'def value(): pass\n');
    const invoke = (adapter, signal, pin = extension) =>
      executeRunner(
        {
          action: 'extension',
          workspace: root,
          adapter: 'deepthought',
          extension: pin,
          tool: 'extension.deepthought.query',
          args: { operation: 'definitions' },
        },
        signal,
        undefined,
        undefined,
        { deepthought: adapter },
      );
    const adapter = await createDeepThoughtAdapter({ python });
    await assert.rejects(
      invoke(adapter, undefined, { ...extension, hash: '0'.repeat(64) }),
      /revision/,
    );
    const cancel = new AbortController();
    const pending = invoke(adapter, cancel.signal);
    setTimeout(() => cancel.abort(), 10);
    await assert.rejects(pending, /cancelled/);
    await assert.rejects(
      invoke(await createDeepThoughtAdapter({ python, timeoutMs: 1 })),
      /timed out/,
    );
    await assert.rejects(
      invoke(await createDeepThoughtAdapter({ python, maxOutputBytes: 128 })),
      /output limit/,
    );
    assert.equal((await invoke(adapter)).status, 'succeeded');
  },
);

test(
  'inspection-bound extensions reject missing or stale grants before reading source',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-deepthought-binding-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await processRun('git', ['init', '-q', root]);
    await writeFile(join(root, 'source.py'), 'class Scoped: pass\n');
    const policy = createExecutionPolicy({
      state: { projects: [], tickets: [] },
      catalog: { ticket: () => undefined, project: () => ({ executionProfile: 'inspect' }) },
    });
    const grant = policy.resolve(
      { id: 'session', projectId: 'project', executionProfile: 'inspect' },
      { id: 'runner', environmentId: 'environment' },
    );
    const execution = {
      version: 1,
      grant,
      policyDigest: grant.digest,
      assignmentToken: randomUUID(),
      workspace: root,
    };
    await executeRunner({
      action: 'bind_execution',
      workspace: root,
      binding: {
        version: 1,
        profileId: 'inspect',
        assignmentToken: execution.assignmentToken,
        policyDigest: grant.digest,
      },
    });
    const request = {
      action: 'extension',
      workspace: root,
      extension,
      adapter: 'deepthought',
      tool: 'extension.deepthought.query',
      args: { operation: 'definitions' },
    };
    const adapters = { deepthought: await createDeepThoughtAdapter({ python }) };
    await assert.rejects(
      executeRunner(request, undefined, undefined, undefined, adapters),
      /descriptor.*bound assignment/,
    );
    const allowed = { ...request, accessMode: 'contained', executionProfile: 'inspect', execution };
    assert.equal(
      (await executeRunner(allowed, undefined, undefined, undefined, adapters)).matches[0].symbol,
      'Scoped',
    );
    await assert.rejects(
      executeRunner(
        { ...allowed, execution: { ...execution, assignmentToken: 'stale' } },
        undefined,
        undefined,
        undefined,
        adapters,
      ),
      /bound assignment/,
    );
  },
);
